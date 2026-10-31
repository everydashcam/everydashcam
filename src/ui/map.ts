import { readLocalStorage, writeLocalStorage, readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
import { zoomForDiameterKm } from "../coordinates.js";
import { lowerBoundBy } from "../sorted-search.js";
// Map (large + mini) on MapLibre. Single owner of map instances,
// markers, popups, rAF marker loop, expand/collapse, mini-map morph animations,
// follow modes, theme-aware tile style, and GPS-point hover popups.
//
// Reverse dependencies (sidebar/player/chart → map): via direct import.
// Forward dependencies (map → seek/chart layout): via initMap callbacks.

// Type-only import: erased at build, so it does NOT pull the ~1MB maplibre-gl
// lib into the bundle. Every `maplibregl.X` below is a type position. The
// runtime namespace is loaded lazily via loadMaplibre() (see the holder under
// the imports), which is what keeps maplibre off the landing critical path.
// Namespace form: v6 is ESM-only and has no default export.
import { formatSpeedReading } from "../gps-telemetry.js";
import { syncMobileViewNav } from "./mobile-view-nav.js";
import type * as maplibregl from "maplibre-gl";
// Worker entry URL, resolved at build time to a string - the lib itself stays
// out of the eager graph. Keep `?worker&url` so Vite builds the worker and the
// portable plugin can embed its classic IIFE for file origins.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import { probeWebGL } from "../capabilities.js";
import { mercatorY, unwrapLongitude, unwrapTrackCoordinates, wrapDegrees } from "../coordinates.js";
import { gMagnitude, hasAccelData } from "../events.js";
import { escapeHtml } from "../escape.js";
import { getCurrentLang, getDateLocale, t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { emitLifecycle } from "../perf.js";
import { isValidGpsFix } from "../parser.js";
import { captureSentryMessage } from "../sentry.js";
import {
    COARSE_POINTER_QUERY,
    MOBILE_LAYOUT_QUERY,
    isCoarsePointer,
    isMobileLayout,
    prefersReducedMotion,
} from "./media-queries.js";
import type { GpsRecord } from "../parser.js";
import { displayClockDate, frameMediaOffset, wallToContentSec, type Trip, type TripFrame } from "../trips.js";
import {
    getViewPanels,
    getPreferredMapMode,
    type MapViewMode,
    setMapModeRequestHandler,
    setMapViewModePreference,
    setPanelAvailable,
    subscribeViewPanels,
    syncMapModeControl,
} from "./view-menu.js";

const log = createLogger("map");

import { isOffline, subscribeConnectivity } from "./connectivity.js";
import { dom, effectiveMasterChannel, onActivePlayerEvent } from "./dom.js";
import { subscribeExportState } from "./export-state.js";
import { cachedDateTimeFormat, formatNumber, formatTime, POPUP_CLOCK_FORMAT } from "./format.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { activeFrame, activeTrip, state } from "./state.js";
import { videoPresentedFrame, type PlayerFrameObservation } from "./player-frame-time.js";
import { installMapRenderCadence, type MapRenderCadence } from "./map-render-cadence.js";
import type { FollowMode, LngLatTuple, MiniMapData } from "./state.js";
import { formatSpeedFromMs, getUnits, subscribeUnitsChange } from "../units-pref.js";
import { currentMapTheme, mapThemeColors, themeColors } from "./theme.js";
import type { MapStyleId, MapTheme } from "./theme.js";
import { applyViewerLabelPrefs } from "./map-label-scale.js";
import { applyMapStylePreset } from "./map-style-preset.js";
import { getMapViewPreferences, subscribeMapViewPreferences } from "./map-view-pref.js";
import { getMapMarkerAppearance, MAP_MARKER_SIZE_PX, subscribeMapMarkerAppearance } from "./map-marker-pref.js";
import {
    mapMarkerPitchScale,
    mapMarkerRenderKey,
    mapMarkerViewForPitch,
    renderMapMarkerIntoCanvas,
} from "./map-marker-renderer.js";
import {
    getMapProvider,
    getMapProviderPreference,
    mapProviderErrorKey,
    reportMapProviderTileError,
    retryMapProvider,
    subscribeMapProvider,
    type MapProvider,
} from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY, MAX_MAP_PITCH_DEG } from "./map-provider-registry.js";
import { MapAttributionControl } from "./map-attribution-control.js";
import { createYandexMapStyle } from "./yandex-map.js";
import { registerSharedMapTileCache, transformMapTileRequest } from "./map-tile-cache.js";
import { createPortableMapAssetLoader } from "./portable-map-assets.js";
import { loadMapStyleSource } from "./map-style-source.js";
import {
    createFallbackMapStyle,
    OSM_SHORTBREAD_BUILDING_SOURCE_LAYER,
    OSM_SHORTBREAD_SOURCE_ID,
} from "./osm-fallback-style.js";
import { buildMercatorCumulativeDistances, buildSpeedGradient } from "./speed-gradient.js";
import { addSpeedTrack, removeSpeedTrack, speedTrackOuterWidth } from "./map-track.js";
import { buildLucideIcon } from "./icons.js";
import { mapPositionAt } from "./map-position.js";

let mapGpsStatus: HTMLDivElement | null = null;
let miniMapGpsStatus: HTMLDivElement | null = null;
let miniStartMarker: maplibregl.Marker | null = null;
let miniEndMarker: maplibregl.Marker | null = null;

function buildGpsStatusBadge(container: HTMLElement): HTMLDivElement {
    const badge = document.createElement("div");
    badge.className = "map-no-gps";
    badge.hidden = true;
    badge.title = t("map.noGps");
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", badge.title);
    const icon = buildLucideIcon(
        [
            "M12 21c-4-4.5-6-7.7-6-10.5a6 6 0 1 1 12 0C18 13.3 16 16.5 12 21z",
            "M12 8.5a2 2 0 1 0 0 4a2 2 0 1 0 0-4",
            "M4 4l16 16",
            "M4 4l16 16",
        ],
        22,
    );
    icon.setAttribute("aria-hidden", "true");
    badge.appendChild(icon);
    container.appendChild(badge);
    return badge;
}

function syncGpsStatus(hasPosition: boolean): void {
    for (const badge of [mapGpsStatus, miniMapGpsStatus]) {
        if (badge && badge.hidden !== hasPosition) badge.hidden = hasPosition;
    }
    if (state.marker) setMarkerHidden(state.marker, !hasPosition);
    if (state.miniMapMarker) setMarkerHidden(state.miniMapMarker, !hasPosition);
}

// --- lazy maplibre-gl loading (T9) ---
//
// maplibre-gl is ~1MB. A static value-import put the lib in the landing entry
// chunk - Vite modulepreloaded it before any trip was opened, pure waste on the
// indexed home page (LCP/TBT hit). We load the runtime namespace once, on
// demand, and keep it in `mlg`. loadMaplibre() is awaited by initTripUi (before
// any map is created) and by export-map-snapshot. Invariant: nothing constructs
// a map/marker/popup before loadMaplibre() resolves, so the `mlg!` assertions at
// the `new mlg!.X` sites below always hold (ensureMap/ensureMiniMap and every
// marker/popup helper run on the trip path, after init).
type MaplibreNamespace = typeof import("maplibre-gl");
let mlg: MaplibreNamespace | null = null;

// Loads maplibre-gl on first call (memoized) and returns the runtime namespace
// so other lazy entry points share the one loaded copy. The dynamic import() is
// what moves the lib out of the eager graph into its own on-demand chunk.
export async function loadMaplibre(): Promise<MaplibreNamespace> {
    if (!mlg) {
        const mod = await import("maplibre-gl");
        // Bundlers cannot resolve the worker from the lib's own `import.meta.url`,
        // so v6 requires the consumer to hand it the URL. Must happen before the
        // first Map is constructed - the dispatcher is created eagerly with it.
        mod.setWorkerUrl(maplibreWorkerUrl);
        registerSharedMapTileCache(mod.addProtocol);
        if (__PORTABLE__) mod.addProtocol("dcasset", createPortableMapAssetLoader(__PORTABLE_MAP_ASSETS__));
        mlg = mod;
    }
    return mlg;
}

interface MapCallbacks {
    /** Track click - seek player to the nearest GPS point. */
    onSeekTripTime: (targetSec: number) => void;
    /** refreshMap flips state.hasTrack - chart layout needs updating. */
    onChartLayoutChange: () => void;
}

let callbacks: MapCallbacks = {
    onSeekTripTime: () => {},
    onChartLayoutChange: () => {},
};

// 10 s timeout for style.json fetch. The file is same-origin (CF Pages) and
// typically responds in <500 ms; the ceiling covers slow mobile (EDGE / poor
// coverage) and rare CF PoP slowness. The map canvas appears immediately with
// EMPTY_MAP_STYLE, so the user is not blocked - timeout only affects when the base
// layer becomes visible.
const MAP_STYLE_TIMEOUT_MS = 10000;

// Minimal valid MapLibre style with no base layer. Used as the initial value so
// the map canvas appears immediately while the real style loads (or as permanent
// fallback if fetch fails).
export const EMPTY_MAP_STYLE: maplibregl.StyleSpecification = {
    version: 8,
    sources: {},
    layers: [],
};

// Style cache: both maps share one URL per theme, no double fetch. The promise
// is cleared after failure so retry triggers a real re-request. Both themes are
// prefetched from ensureMap (the inactive one with source="prefetch", silent on
// failure) so theme toggles and the export-overlay snapshotter (always "light")
// hit the cache instead of triggering a fresh fetch with its own failure surface.
type MapStyleCacheKey = `${MapProvider}:${MapStyleId}`;
const cachedMapStyles = new Map<MapStyleCacheKey, maplibregl.StyleSpecification>();
interface PendingMapStyle {
    promise: Promise<maplibregl.StyleSpecification | null>;
    source: MapLoadSource;
}
const mapStyleLoadPromises = new Map<MapStyleCacheKey, PendingMapStyle>();
// AbortController for the in-flight fetch per theme. force=true aborts it via
// signal.reason="superseded" so the .catch knows the failure was our own
// teardown and stays silent (no analytics event, no banner). Without this the
// orphaned fetch keeps running and its eventual failure fires a spurious
// map_load_failed.
const mapStyleLoadControllers = new Map<MapStyleCacheKey, AbortController>();

function styleCacheKey(provider: MapProvider, theme: MapStyleId): MapStyleCacheKey {
    return `${provider}:${theme}`;
}
interface FailedMapStyle {
    theme: MapStyleId;
    provider: MapProvider;
    source: MapLoadSource;
}
// Export can request a different palette from the viewer. Retain its request
// identity so an unrelated viewer success cannot dismiss or misdirect a retry.
let lastFailedStyle: FailedMapStyle | null = null;

/**
 * Where a loadMapStyle call originates. Sent to GA4 as `source` on
 * map_load_failed so we can tell apart "the main map failed to load"
 * (severity: user blocked) from "an export-overlay snapshot failed"
 * (severity: optional feature degraded) - they used to merge.
 *
 * "prefetch" warms the inactive theme in the background; "preview" has its
 * own local route fallback. Both stay silent so an optional request cannot
 * raise or dismiss the main map's error state.
 */
export type MapLoadSource = "main" | "export" | "preview" | "prefetch";

function isSilentMapLoadSource(source: MapLoadSource): boolean {
    return source === "prefetch" || source === "preview";
}

function isRelevantMapLoad(source: MapLoadSource, theme: MapStyleId, provider: MapProvider): boolean {
    return (
        !isSilentMapLoadSource(source) &&
        provider === getMapProvider() &&
        (source === "export" || theme === currentMapTheme())
    );
}

function clearMapStyleFailure(source: MapLoadSource, theme: MapStyleId, provider: MapProvider): void {
    if (!isRelevantMapLoad(source, theme, provider)) return;
    const failure = lastFailedStyle;
    if (
        failure &&
        (failure.theme !== theme || failure.provider !== provider) &&
        isRelevantMapLoad(failure.source, failure.theme, failure.provider)
    )
        return;
    lastFailedStyle = null;
    hideMapStyleError();
}

/**
 * Fetches the tile style JSON with a timeout. Caches the result - repeat calls
 * on success return the same object; on failure (null) a new fetch is started.
 * force=true aborts any in-flight fetch and clears the cache, used by the retry
 * button to avoid getting the same null from a previously cached failure.
 * source labels the call site for diagnostics + decides whether the failure
 * surfaces in the UI. Background prefetches and previews with a local fallback
 * stay silent.
 */
export function loadMapStyle(
    theme: MapStyleId,
    force = false,
    source: MapLoadSource = "main",
    provider: MapProvider = getMapProvider(),
): Promise<maplibregl.StyleSpecification | null> {
    if (provider === "route-only") {
        clearMapStyleFailure(source, theme, provider);
        return Promise.resolve(EMPTY_MAP_STYLE);
    }
    const key = styleCacheKey(provider, theme);
    if (force) {
        // Actually abort the previous fetch instead of just dropping the
        // reference. Otherwise it keeps running, its eventual catch can stomp
        // the freshly-set mapStyleLoadPromise[theme] and emits a stale
        // map_load_failed analytics event.
        const oldCtrl = mapStyleLoadControllers.get(key);
        if (oldCtrl) oldCtrl.abort("superseded");
        cachedMapStyles.delete(key);
        mapStyleLoadPromises.delete(key);
        mapStyleLoadControllers.delete(key);
    }
    const cached = cachedMapStyles.get(key);
    if (cached) {
        clearMapStyleFailure(source, theme, provider);
        return Promise.resolve(cached);
    }
    const inflight = mapStyleLoadPromises.get(key);
    if (inflight) {
        // Export still needs this palette after the viewer chooses another one.
        if (!isSilentMapLoadSource(source) && inflight.source !== "export") inflight.source = source;
        return inflight.promise;
    }

    if (provider !== "openfreemap") {
        const style =
            provider === "yandex" ? createYandexMapStyle(getCurrentLang()) : createFallbackMapStyle(provider, theme);
        if (!style) return Promise.resolve(null);
        cachedMapStyles.set(key, style);
        clearMapStyleFailure(source, theme, provider);
        log.info("map style loaded", { theme, provider, durationMs: 0 });
        return Promise.resolve(style);
    }

    const ctrl = new AbortController();
    mapStyleLoadControllers.set(key, ctrl);
    // Pass a distinct reason so the catch can tell timeout-abort apart from
    // force-supersede-abort. Default DOMException would conflate the two.
    const timeoutId = window.setTimeout(() => ctrl.abort("timeout"), MAP_STYLE_TIMEOUT_MS);
    const fetchStart = performance.now();

    const promise: Promise<maplibregl.StyleSpecification | null> = loadMapStyleSource(theme, ctrl.signal)
        .then((style) => {
            if (ctrl.signal.aborted && ctrl.signal.reason === "superseded") return null;
            // MapLibre refuses relative sprite/glyphs URLs at runtime
            // ("Invalid sprite URL ..., must be absolute"). Our self-hosted
            // dark style ships sprite: "/styles/sprite/sprite" - resolve it
            // against location.origin so it becomes absolute. Same treatment
            // for glyphs if any local style ever adds them.
            if (typeof style.sprite === "string" && style.sprite.startsWith("/")) {
                style.sprite = new URL(style.sprite, location.origin).href;
            }
            if (typeof style.glyphs === "string" && style.glyphs.startsWith("/")) {
                style.glyphs = new URL(style.glyphs, location.origin).href;
            }
            cachedMapStyles.set(key, style);
            clearMapStyleFailure(pending.source, theme, provider);
            // The tile server is the only external runtime dependency. Style load
            // time is the first proxy for network issues; clearly visible in a
            // "map opens slowly" bug report.
            log.info("map style loaded", {
                theme,
                provider,
                durationMs: Math.round(performance.now() - fetchStart),
            });
            return style;
        })
        .catch((err: unknown) => {
            // Our own force=true tore this fetch down to start a fresh one -
            // not a real failure. No banner, no analytics, no log noise.
            if (ctrl.signal.aborted && ctrl.signal.reason === "superseded") {
                return null;
            }
            const isTimeout = ctrl.signal.aborted && ctrl.signal.reason === "timeout";
            const reasonForLog = isTimeout ? "timeout" : err;
            log.warn("map style fetch failed", {
                theme,
                source: pending.source,
                reason: reasonForLog instanceof Error ? reasonForLog.message : reasonForLog,
            });
            // Clear in-flight promise/ctrl so the next loadMapStyle starts a
            // real new fetch. Guard with identity check: between our request
            // start and our own .catch a force=true may have already replaced
            // both fields - we must not stomp the newer references.
            if (mapStyleLoadPromises.get(key) === pending) {
                mapStyleLoadPromises.delete(key);
            }
            if (mapStyleLoadControllers.get(key) === ctrl) {
                mapStyleLoadControllers.delete(key);
            }
            // A late failure from an abandoned viewer theme/provider must not
            // replace the current error or restart recovery for a working map.
            if (!isRelevantMapLoad(pending.source, theme, provider)) return null;
            lastFailedStyle = { theme, provider, source: pending.source };
            showMapStyleError();
            scheduleMapRecovery();
            return null;
        })
        .finally(() => {
            window.clearTimeout(timeoutId);
        });

    const pending: PendingMapStyle = { promise, source };
    mapStyleLoadPromises.set(key, pending);
    return promise;
}

interface RenderedMapTrack {
    trip: Trip;
    records: GpsRecord[];
    recordCount: number;
}
let renderedMapTrack: RenderedMapTrack | null = null;
let preservedStyleTrack: RenderedMapTrack | null = null;
// A lost context cannot accept style changes. Retain only the latest choice.
const lostViewerMapStyles = new WeakMap<maplibregl.Map, maplibregl.StyleSpecification | null>();

function setViewerMapStyle(map: maplibregl.Map, style: maplibregl.StyleSpecification): void {
    if (lostViewerMapStyles.has(map)) lostViewerMapStyles.set(map, style);
    else map.setStyle(style, { diff: false });
}

/** Applies only the current theme/provider; style.load restores local overlays. */
function applyLoadedStyle(
    style: maplibregl.StyleSpecification,
    theme: MapStyleId,
    provider = getMapProvider(),
    shouldPreserveCamera = false,
): void {
    // Only the live UI theme is ever applied to the on-screen maps. A retried
    // "neon" fetch (export-overlay failure) re-caches neon.json but never equals
    // currentMapTheme(), so it falls out here - the next export reads the cache.
    if (theme !== currentMapTheme() || provider !== getMapProvider()) return;
    // diff:false - do not try to preserve sources/layers across styles. The trip
    // line redraws via style.load; diff:true could place our layer at a wrong
    // z-order in the new style.
    //
    // Label prefs (text scale + street-name density) are applied to a clone
    // HERE, not in loadMapStyle: the cache must stay pristine because the
    // export snapshotter reads the same cache with its own independent
    // per-export factor.
    const styled = applyViewerMapStyle(style);
    if (state.map) {
        const map = state.map;
        // setStyle retains the camera. A different trip loaded during the swap
        // must still get its own framing when the style is ready.
        preservedStyleTrack = shouldPreserveCamera ? renderedMapTrack : null;
        setViewerMapStyle(map, styled);
        mapAttributionControl.setProvider(provider);
    }
    if (state.miniMap) {
        setViewerMapStyle(state.miniMap, styled);
        miniMapAttributionControl.setProvider(provider);
    }
}

/**
 * Re-applies the current theme's cached style to the live maps so a changed
 * label preference (text scale, street-name density) takes effect
 * immediately. Called by the settings modal and the map gear popover; a no-op
 * while the style fetch is still in flight (the pending
 * loadMapStyle().then(applyLoadedStyle) will pick the new prefs up anyway).
 */
export function reapplyMapLabelPrefs(): void {
    const theme = currentMapTheme();
    const provider = getMapProvider();
    const cached = cachedMapStyles.get(styleCacheKey(provider, theme));
    if (cached) applyLoadedStyle(cached, theme, provider, true);
}

export function applyViewerMapStyle(style: maplibregl.StyleSpecification): maplibregl.StyleSpecification {
    return applyViewerLabelPrefs(applyMapStylePreset(style, getMapViewPreferences().style));
}

function viewerMapColors(): ReturnType<typeof mapThemeColors> {
    const provider = getMapProvider();
    return mapThemeColors(MAP_PROVIDER_REGISTRY[provider].usesSelectedTheme ? currentMapTheme() : "light");
}

function showMapStyleError(): void {
    if (!dom.mapStyleError) return;
    dom.mapStyleError.hidden = false;
}

function hideMapStyleError(): void {
    if (!dom.mapStyleError) return;
    dom.mapStyleError.hidden = true;
}

// A failed TileJSON or tile stays failed in MapLibre until its source reloads.
// Browser online events cover airplane mode; retries cover a router whose WAN
// returns without changing navigator.onLine.
const MAP_RECOVERY_RETRY_MS = 15_000;
let mapRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

function needsMapRecovery(): boolean {
    if (getMapProvider() === "route-only") return getMapProviderPreference() !== "route-only";
    return isOffline() || lastFailedStyle !== null;
}

function retryMapResources(): void {
    if ((!state.map && !state.miniMap) || navigator.onLine === false) return;
    if (getMapProvider() === "route-only") {
        // Probe before touching a working local map; failed retries must not
        // rebuild its style or interrupt the route and follow camera.
        void retryMapProvider();
        return;
    }
    const theme = lastFailedStyle?.theme ?? currentMapTheme();
    const provider = lastFailedStyle?.provider ?? getMapProvider();
    const source = lastFailedStyle?.source ?? "main";
    void loadMapStyle(theme, false, source, provider).then((style) => {
        if (style) applyLoadedStyle(style, theme, provider, true);
    });
}

function scheduleMapRecovery(): void {
    if (mapRecoveryTimer !== null || !needsMapRecovery()) return;
    mapRecoveryTimer = setTimeout(() => {
        mapRecoveryTimer = null;
        if (!needsMapRecovery()) return;
        retryMapResources();
        scheduleMapRecovery();
    }, MAP_RECOVERY_RETRY_MS);
}

// Active user gestures on the map (keys: "drag"/"rotate"/"pitch"). Non-empty
// means the per-frame follow camera must not interrupt with programmatic moves. A Set
// (not a counter) so a missing '*end' - MapLibre does not guarantee one when a
// gesture is interrupted by setStyle/theme-swap or WebGL context loss - self-
// heals on the next complete gesture of that type (a counter would latch >0 and
// kill follow for the whole session). Also cleared on every style.load.
const activeMapGestures = new Set<string>();

// Cached track scaffolding used by the rAF loop to compute current line-progress
// for the trail overlay. Populated in refreshMap from the deduped record list
// so all consumers share the same indexing.
let trackRecs: GpsRecord[] = [];
let trackCumDist: number[] = [];
let trackTotalDist = 0;

const TRIP_SOURCE_ID = "trip-line";
const TRAIL_LAYER_SUFFIX = "-trail";

/**
 * Maps the player currentTime to a [0..1] progress along the track. Uses the
 * same binary search shape as interpolatePosition but returns a normalized
 * distance instead of a position, so the trail overlay can mask the not-yet-
 * driven portion via line-gradient stops.
 */
function computeTrackProgress(targetUnix: number): number {
    if (trackRecs.length < 2 || trackTotalDist === 0) return 0;
    const lo = Math.min(
        lowerBoundBy(trackRecs, targetUnix, (record) => record.unixSeconds),
        trackRecs.length - 1,
    );
    if (lo === 0) return 0;
    const prev = trackRecs[lo - 1]!;
    const next = trackRecs[lo]!;
    const span = next.unixSeconds - prev.unixSeconds;
    const t = span > 0 ? Math.max(0, Math.min(1, (targetUnix - prev.unixSeconds) / span)) : 0;
    const cumPrev = trackCumDist[lo - 1]!;
    const cumNext = trackCumDist[lo]!;
    const cum = cumPrev + (cumNext - cumPrev) * t;
    return Math.max(0, Math.min(1, cum / trackTotalDist));
}

// Trail write gating. Each line-gradient write regenerates a color-ramp
// texture per visible tile the line crosses (maplibre bumps gradientVersion),
// so writes are rationed by how far the veil BOUNDARY moved on screen - a
// fraction-of-trip threshold either starved short trips or visibly trailed the
// car on long ones (0.5% of 100 km = 500 m of stale veil at street zoom).
// cumDist is in mercator degree-equivalent units (world = 360; see
// buildMercatorCumulativeDistances), so boundary px shift =
// dProgress * total * tileSize * 2^zoom / 360. A hard rate cap bounds the
// texture-regen frequency at high zoom; the max interval bounds staleness at
// overview zoom.
let trailLastProgressWritten = -1;
let trailLastWriteAt = 0;
const TRAIL_MIN_BOUNDARY_SHIFT_PX = 8;
const TRAIL_MIN_WRITE_INTERVAL_MS = 250;
const TRAIL_MAX_WRITE_INTERVAL_MS = 1000;
const MAPLIBRE_TILE_SIZE_PX = 512;

// Trailing-edge retry for a rate-capped write. setTrailProgress is only called
// while the playhead moves, so a large shift dropped by the rate cap (typical:
// the final position of a fast scrub) would otherwise never be written and the
// veil would sit visibly stale until the next playback. One timer, re-aimed at
// the latest progress.
let trailPendingTimer: number | null = null;
let trailPendingProgress = 0;

function scheduleTrailingTrailWrite(progress: number): void {
    trailPendingProgress = progress;
    if (trailPendingTimer !== null) return;
    trailPendingTimer = window.setTimeout(() => {
        trailPendingTimer = null;
        setTrailProgress(trailPendingProgress);
    }, TRAIL_MIN_WRITE_INTERVAL_MS);
}

function cancelTrailingTrailWrite(): void {
    if (trailPendingTimer !== null) {
        window.clearTimeout(trailPendingTimer);
        trailPendingTimer = null;
    }
}

/**
 * Updates the trail overlay's line-gradient so the un-driven part of the track
 * is dimmed. Four stops: transparent [0..progress], then a step into dimColor
 * [progress..1]. The step is 0.0001 wide so MapLibre's linear interpolation
 * does not bleed colors across the boundary.
 */
function setTrailProgress(progress: number): void {
    if (!state.map) return;
    const layerId = `${TRIP_SOURCE_ID}${TRAIL_LAYER_SUFFIX}`;
    if (!state.map.getLayer(layerId)) return;
    const now = performance.now();
    const sincePrevMs = now - trailLastWriteAt;
    const boundaryShiftPx =
        Math.abs(progress - trailLastProgressWritten) *
        trackTotalDist *
        ((MAPLIBRE_TILE_SIZE_PX * 2 ** state.map.getZoom()) / 360);
    if (boundaryShiftPx < TRAIL_MIN_BOUNDARY_SHIFT_PX && sincePrevMs < TRAIL_MAX_WRITE_INTERVAL_MS) return;
    if (sincePrevMs < TRAIL_MIN_WRITE_INTERVAL_MS) {
        // A LARGE shift hit the rate cap - retry it on the trailing edge (a
        // sub-threshold shift above just returns: staleness under 8 px is
        // invisible, no retry needed).
        scheduleTrailingTrailWrite(progress);
        return;
    }
    cancelTrailingTrailWrite();
    trailLastProgressWritten = progress;
    trailLastWriteAt = now;
    const dim = viewerMapColors().trackVeil;
    const transparent = "rgba(0,0,0,0)";
    // line-gradient inputs must be STRICTLY ascending. We emit four stops:
    // 0 -> p (transparent), p+eps -> 1 (dim). Clamp p so neither 0==p nor
    // p+eps==1 collapses. eps=1e-4 is small enough to be invisible but
    // large enough to survive float rounding.
    const eps = 0.0001;
    const p = Math.max(eps, Math.min(1 - 2 * eps, progress));
    const gradient: unknown[] = [
        "interpolate",
        ["linear"],
        ["line-progress"],
        0,
        transparent,
        p,
        transparent,
        p + eps,
        dim,
        1,
        dim,
    ];
    state.map.setPaintProperty(layerId, "line-gradient", gradient as never);
}

const mapAttributionControl = new MapAttributionControl(getMapProvider(), { avoidPlayerControls: true });
const miniMapAttributionControl = new MapAttributionControl(getMapProvider(), { reserveBottomSpace: true });

/**
 * Installs a transparent 1x1 stub for every icon the style asks for but the
 * sprite does not carry (Liberty references POI icons - running, office,
 * hospital - that its sprite omits). Without it MapLibre warnOnce's per missing
 * icon; with it the POIs simply render label-only. Shared by both live maps.
 *
 * Must be a resolver, not a `styleimagemissing` listener: since v6 the event is
 * notify-only and addImage from it no longer satisfies the pending request.
 */
function stubMissingStyleImages(map: maplibregl.Map): void {
    map.setMissingStyleImageResolver((id) => {
        if (map.hasImage(id)) return;
        map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
}

function observeViewerMap(map: maplibregl.Map, surface: "main" | "mini"): void {
    // One diagnostic per provider/failure keeps offline tile misses bounded.
    const seenErrors = new Set<string>();
    const prefix = surface === "mini" ? "mini " : "";
    map.on("error", (ev) => {
        const error = ev?.error || ev;
        const message = error?.message ?? String(error);
        reportMapProviderTileError(error);
        const key = mapProviderErrorKey(error);
        if (seenErrors.has(key)) return;
        seenErrors.add(key);
        log.error(`maplibre ${prefix}error`, error instanceof Error ? error : { message });
    });
    map.on("webglcontextlost", () => {
        // MapLibre discards the style without styledataloading. Block overlay
        // writes until recovery emits style.load: addSource on a missing style
        // synchronously emits style.load and re-enters track creation.
        if (surface === "main") state.mapReady = false;
        else state.miniMapReady = false;
        lostViewerMapStyles.set(map, null);
        log.warn(`${prefix}webgl context lost`);
        captureSentryMessage("map webgl context lost", {
            level: "warning",
            fingerprint: ["map_webgl_context_lost"],
            tags: { map: surface },
        });
    });
    map.on("webglcontextrestored", () => {
        const pendingStyle = lostViewerMapStyles.get(map);
        lostViewerMapStyles.delete(map);
        if (pendingStyle) setViewerMapStyle(map, pendingStyle);
        log.info(`${prefix}webgl context restored`);
    });
    stubMissingStyleImages(map);
}

// Set once when MapLibre cannot get a WebGL context (blocklisted/ancient GPU,
// hardware acceleration off). Map + mini-map are then skipped, the in-panel
// notice is shown, and every map-dependent path no-ops via the existing
// state.map/state.miniMap null guards - video, chart and export keep working.
let mapInitFailed = false;

/** False after a WebGL context could not be created for the map. Other modules
 *  consult this to skip map-only work or surface the right message. */
export function isMapAvailable(): boolean {
    return !mapInitFailed;
}

/**
 * Marks the map as permanently unavailable for this session and surfaces the
 * reason in the map panel. Idempotent. Reason is WebGL: MapLibre needs WebGL2,
 * so reaching here means no usable WebGL2 context.
 */
function handleMapInitFailure(err?: unknown): void {
    if (mapInitFailed) return;
    mapInitFailed = true;
    log.error("map unavailable: no WebGL context", err instanceof Error ? err : { err: String(err) });
    if (typeof document !== "undefined") {
        // Body class hides the mini-map (an empty panel would be
        // worse than nothing) and the map toggle; CSS in components/map.css.
        document.body.classList.add("map-unavailable");
        const notice = document.getElementById("map-unavailable");
        if (notice) notice.hidden = false;
    }
}

export function ensureMap(): maplibregl.Map | null {
    if (state.map) return state.map;
    if (mapInitFailed) return null;
    // Preflight the WebGL context ourselves (same probe the capability report
    // uses) so we degrade deterministically instead of depending on MapLibre's
    // throw-vs-async-error behaviour on a context-less GPU.
    if (!probeWebGL()) {
        handleMapInitFailure();
        return null;
    }

    let map: maplibregl.Map;
    try {
        map = new mlg!.Map({
            container: "map",
            // Start with empty inline style so the canvas appears immediately; real
            // style loads async via loadMapStyle below. Also covers graceful
            // degradation: if the tile server is unavailable the canvas stays blank
            // but track/markers/popups keep working (sources are added on top of any
            // style).
            style: EMPTY_MAP_STYLE,
            center: [0, 0],
            zoom: 1,
            // Default AttributionControl can't be reliably forced into "collapsed
            // by default" - the <details> element opens itself on certain map
            // widths regardless of the compact flag. We add our own minimal "i"
            // pill via addControl below, styled to match the rest of map-controls.
            attributionControl: false,
            // Performance tuning - see ensureMiniMap for refreshExpiredTiles /
            // crossSourceCollisions. fadeDuration is deliberately left at its
            // default (300 ms) here, unlike the mini-map: besides the label
            // fade it doubles as the symbol-placement throttle
            // (Placement.stillRecent) - at 0 the label collision pass restarts
            // every rendered frame, a continuous main-thread cost while the
            // follow camera keeps the map moving. At 300 ms placement runs at
            // most ~3x/s and labels cross-fade instead of popping.
            refreshExpiredTiles: true,
            crossSourceCollisions: false,
            // Pitch (tilt) is driven ONLY programmatically, by followMode
            // "chase" (and its tilt slider). We keep the direct gesture pitch
            // controls OFF so a stray ctrl-drag / two-finger pinch (mobile is
            // first-class here) cannot strand the map tilted with no obvious way
            // back - the compass resets bearing, not pitch. dragRotate stays on:
            // bearing rotation IS used ("rotate"/"chase" follow, compass).
            pitchWithRotate: false,
            touchPitch: false,
            // Raise the ceiling above the 60 default so the chase camera can
            // reach CHASE_MAX_PITCH_DEG. Capped at 70 (< the 85 hard max): past
            // ~70 the renderer pulls in far too many tiles near the horizon
            // (MapLibre flags pitch>60 experimental for exactly this) for little
            // gain at street zoom. Non-chase modes ease pitch back to 0.
            maxPitch: CHASE_MAX_PITCH_DEG,
            // Skip MapLibre's runtime style validation: styles are static, self-
            // hosted and gated at build time by scripts/validate-map-styles.mjs
            // (pretest + prebuild). The flag also propagates to the
            // setStyle(diff:false) theme-swap path, so the heavy style is not
            // re-validated on theme toggle either.
            validateStyle: false,
            // Cooperative gestures whenever the page can scroll past the map:
            // on touch, one finger must scroll and two move the map; in the
            // stacked layout the same holds for the wheel on any pointer -
            // otherwise a squeezed desktop window can never scroll down to the
            // timeline (zoom moves to Ctrl/Cmd+scroll, with MapLibre's own
            // overlay hint). The wide desktop split keeps plain wheel-zoom.
            // syncCooperativeGestures() resyncs on pointer/layout flips.
            cooperativeGestures: isCoarsePointer() || isMobileLayout(),
            transformRequest: transformMapTileRequest,
            // Localized overlay text ("use two fingers"). MapLibre bakes it into the
            // DOM at enable() time from this table; langchange refresh via
            // localizeCooperativeOverlay() below.
            locale: cooperativeLocale(),
        });
    } catch (err) {
        // WebGL context creation can still throw on some drivers even after the
        // preflight passed (e.g. a context lost between probe and construction).
        handleMapInitFailure(err);
        return null;
    }
    state.map = map;
    mapGpsStatus = buildGpsStatusBadge(dom.mapWrap);
    followRenderCadence = installMapRenderCadence(map, () => {
        const frame = followVideoFrame(performance.now());
        if (
            !frame ||
            followAppliedVideo !== dom.player ||
            followAppliedFrame?.file !== frame.file ||
            followAppliedFrame.src !== frame.src
        )
            return null;
        return followAppliedFrame;
    });
    syncProviderCamera();

    // Markers stay viewport-aligned for legibility, then receive a deliberately
    // milder manual foreshortening than MapLibre's full map-plane projection.
    map.on("pitch", () => {
        setMarkerPitch(state.marker, map.getPitch());
        syncMapCompassAvailability();
    });

    map.on("styledataloading", () => {
        state.mapReady = false;
    });

    observeViewerMap(map, "main");

    // Cache the container size for the follow loop (teleport guard). The
    // initial read is off the hot path; MapLibre fires 'resize' for both
    // window resizes and programmatic map.resize() (applyMapLayout), so the
    // cache stays current without per-frame layout reads.
    const updateFollowViewportSize = (): void => {
        const el = map.getContainer();
        bigMapViewportPx = Math.max(el.clientWidth, el.clientHeight, 1);
    };
    updateFollowViewportSize();
    map.on("resize", updateFollowViewportSize);
    map.on("resize", syncBigMapPixelRatio);

    // Standard NavigationControl: +/- zoom, compass. Pitch not shown - 3D tilt
    // without real elevation data looks cheap.
    map.addControl(
        new mlg!.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: false }),
        "top-right",
    );
    guardMapCompass(map);

    const scaleControl = new mlg!.ScaleControl({ maxWidth: 120, unit: getUnits() });
    map.addControl(scaleControl, "bottom-left");
    const unsubscribeScaleUnits = subscribeUnitsChange((unit) => scaleControl.setUnit(unit));
    map.once("remove", unsubscribeScaleUnits);

    // Custom attribution stays visible in the bottom-right. Replaces the
    // default AttributionControl (see attributionControl:false above).
    map.addControl(mapAttributionControl, "bottom-right");

    // NavigationControl labels use MapLibre's locale instead of the page's.
    localizeMapNavControls();

    // Track user map gestures so the rAF loop does not fight them. A live
    // gesture suspends the per-frame follow camera (activeMapGestures); the gesture also
    // arms the post-interaction grace window so auto-follow stays paused for a
    // few seconds after the user lets go (noteUserMapInteraction).
    const startEvents: Array<"dragstart" | "rotatestart" | "pitchstart"> = ["dragstart", "rotatestart", "pitchstart"];
    const endEvents: Array<"dragend" | "rotateend" | "pitchend"> = ["dragend", "rotateend", "pitchend"];
    startEvents.forEach((ev) => {
        map.on(ev, (e) => {
            activeMapGestures.add(ev.slice(0, -"start".length));
            // Arm the pause ONLY on a genuine USER gesture. A programmatic easeTo
            // (chase entry, recenter, follow-switch, fitBounds) can also emit a
            // *start, but carries no originalEvent. Without this guard, entering
            // chase (an easeTo with a pitch change) would fire pitchstart and
            // pause follow the instant it engaged. activeMapGestures still tracks
            // all *starts (it only suspends the per-frame follow camera, harmless for
            // programmatic ones).
            if ((e as { originalEvent?: unknown }).originalEvent) noteUserMapInteraction();
        });
    });
    endEvents.forEach((ev) => {
        map.on(ev, (e) => {
            activeMapGestures.delete(ev.slice(0, -"end".length));
            // Restart the grace countdown from the moment the gesture ends, so the
            // window is measured from the user's LAST touch, not its first. Guard
            // on originalEvent for the same reason as the *start handler (a
            // programmatic ease can emit a *end too).
            if ((e as { originalEvent?: unknown }).originalEvent) noteUserMapInteraction();
        });
    });

    // Manual zoom (wheel, trackpad pinch, double-click, NavigationControl +/-) is
    // a user interaction too: pause auto-follow for the grace window, just like
    // pan/rotate/pitch. It does NOT disable chase speed-adaptive zoom anymore -
    // adaptive re-applies on resume, so the toggle stays the user's deliberate
    // switch, not something a stray scroll flips off.
    //
    // Detection is by the raw zoom-causing events, NOT the 'zoom' event's
    // originalEvent: MapLibre's smooth scroll-zoom fires its per-frame 'zoom'
    // WITHOUT originalEvent (verified), so that check never sees a wheel.
    map.on("wheel", noteUserMapInteraction); // wheel + trackpad pinch-zoom
    map.on("dblclick", noteUserMapInteraction); // double-click zoom
    map.on("touchstart", (e) => {
        // Two fingers = pinch-zoom (one-finger pan already fires dragstart, and
        // pinch fires neither drag nor rotate start). Catch the multi-touch case.
        const points = (e as { points?: unknown[] }).points;
        if (points && points.length >= 2) noteUserMapInteraction();
    });
    // The NavigationControl +/- buttons call zoomIn/Out({}, {originalEvent}) -
    // an easeTo whose per-frame 'zoom' events fire only from the ease's FIRST
    // render callback. The per-frame follow jumpTo calls stop() and would
    // cancel that ease before its first frame, so a 'zoom' listener never sees
    // the click and the buttons go dead while following. 'zoomstart' fires
    // SYNCHRONOUSLY inside zoomIn/Out (with the same eventData), so the grace
    // window arms before the next follow frame and the ease survives. The
    // originalEvent guard still filters our own programmatic camera moves.
    map.on("zoomstart", (e) => {
        if ((e as { originalEvent?: unknown }).originalEvent) noteUserMapInteraction();
    });

    // Redraw the track after every style change (setStyle clears all sources/layers
    // including our trip-line). The first style.load fires for EMPTY_MAP_STYLE with
    // state.active === null - that's a no-op.
    map.on("style.load", () => {
        state.mapReady = true;
        // A setStyle (theme swap) interrupts any in-flight gesture without
        // guaranteeing its '*end'; drop the stale gesture flags so follow-ease
        // is not suspended forever.
        activeMapGestures.clear();
        // NOTE on setSourceTileLodParams: deliberately NOT used. The variable
        // tile zoom it configures only activates at pitch > ~60 deg (mercator
        // allowVariableZoom gate), which the default chase pitch (58) never
        // reaches - and lowering maxZoomLevelsOnScreen below the 9.314 default
        // makes far tiles KEEP more zoom (more tiles, not fewer); the built-in
        // default is already the sane LOD for our pitch range.
        const trip = activeTrip();
        const preserveCamera =
            preservedStyleTrack !== null &&
            trip === preservedStyleTrack.trip &&
            trip.records === preservedStyleTrack.records &&
            trip.records.length === preservedStyleTrack.recordCount;
        preservedStyleTrack = null;
        refreshMap(trip, preserveCamera);
        // setStyle (theme swap) wipes every non-style layer, including our 3D
        // building extrusion. Re-add it - with the new theme's wall color - when
        // chase is the active mode.
        if (state.followMode === "chase" || map.getPitch() > 1) ensure3dBuildings(map);
    });

    // Start loading the real style. Promise is cached so a subsequent
    // ensureMiniMap call does not double-fetch.
    const theme = currentMapTheme();
    const provider = getMapProvider();
    loadMapStyle(theme, false, "main", provider).then((style) => {
        if (style) applyLoadedStyle(style, theme, provider);
    });

    // Warm the alternate palette for map settings and export; background
    // requests must not show a failure banner for an unselected style.
    const otherTheme: MapTheme = theme === "light" ? "dark" : "light";
    loadMapStyle(otherTheme, false, "prefetch", provider);

    return map;
}

/**
 * Mini-map in the player corner. Separate MapLibre instance with the same
 * viewer style, visible credits, and interactive:false. Clicking it expands the
 * large map.
 *
 * The car marker stays centered: camera follows the current position on every
 * rAF tick (see startMarkerLoop). Zoom keeps MINI_MAP_TARGET_WIDTH_KM around
 * the car. Bearing is always 0 (north-up).
 *
 * Web Mercator on MapLibre's 512 px tiles: meters_per_pixel =
 * 78271.5 * cos(lat) / 2^zoom - NOT the 256-tile 156543.03 (MapLibre's zoom is
 * one level "sharper"; see zoomForDiameterKm). The latitude dependency is
 * significant (~1.5 zoom levels from equator to 70°N), so zoom is recomputed
 * dynamically on each jumpTo.
 */
const MINI_MAP_TARGET_WIDTH_KM = 5;
let miniMapWidthPx = 1;

function refreshMiniMapWidth(): void {
    const width = Number.parseFloat(getComputedStyle(dom.miniMap).width);
    if (!Number.isFinite(width) || width <= 0 || width === miniMapWidthPx) return;
    miniMapWidthPx = width;
    // A resized thumbnail needs a new zoom even when the playhead is paused.
    miniAppliedLat = Number.NaN;
}

function miniMapZoomForLat(lat: number): number {
    return zoomForDiameterKm(lat, MINI_MAP_TARGET_WIDTH_KM, Math.max(1, miniMapWidthPx));
}

export function ensureMiniMap(): maplibregl.Map | null {
    if (state.miniMap) return state.miniMap;
    // The big map is ensured first; if its WebGL preflight failed, do not retry.
    if (mapInitFailed) return null;
    if (!probeWebGL()) {
        handleMapInitFailure();
        return null;
    }

    let mini: maplibregl.Map;
    try {
        refreshMiniMapWidth();
        mini = new mlg!.Map({
            container: "mini-map",
            // Start with empty style; real style is applied via applyLoadedStyle
            // after the shared fetch in ensureMap.
            style: EMPTY_MAP_STYLE,
            center: [0, 0],
            // Initial zoom at lat 0; recalculated on every rAF tick via jumpTo.
            zoom: miniMapZoomForLat(0),
            // Fully non-interactive - user should not accidentally pan/rotate it;
            // click is handled by a separate DOM listener that expands the large map.
            interactive: false,
            attributionControl: false,
            // Performance tuning for "car-camera follow" use case:
            //  - fadeDuration:0 - zeroes the 300 ms label-collision fade (per the
            //    style-spec fadeDuration animates symbol collision in/out, NOT
            //    raster tile cross-fade). The mini-map camera moves in sparse
            //    px-gated jumps; a nonzero fade would keep it rendering for
            //    300 ms after every jump - nearly continuous rendering for a
            //    small thumbnail. The big map makes the opposite call (see
            //    ensureMap): there the camera moves continuously anyway and
            //    fadeDuration doubles as the symbol-placement throttle.
            //  - refreshExpiredTiles:true - respect provider cache lifetimes
            //    even when an installed app stays open for a long time.
            //  - crossSourceCollisions:false - disables label-collision detection across
            //    sources (one tile source + our line source). One of the most expensive
            //    algorithms in the render loop.
            fadeDuration: 0,
            refreshExpiredTiles: true,
            crossSourceCollisions: false,
            // The thumbnail only needs a few visible tiles at typical zoom.
            // 32 gives headroom for speed changes and zoom shifts on long trips.
            maxTileCacheSize: 32,
            // Skip runtime style validation (static self-hosted styles, gated at
            // build time). Propagates to the setStyle(diff:false) path used to
            // apply the cached style below. See ensureMap for the full rationale.
            validateStyle: false,
            transformRequest: transformMapTileRequest,
        });
    } catch (err) {
        handleMapInitFailure(err);
        return null;
    }
    state.miniMap = mini;
    miniMapGpsStatus = buildGpsStatusBadge(dom.miniMap);
    // Reading computed width after marker writes forces style work on every
    // playback frame. Map resizes keep the cached width current off that path.
    mini.on("resize", refreshMiniMapWidth);
    mini.addControl(miniMapAttributionControl, "bottom-right");

    mini.on("styledataloading", () => {
        state.miniMapReady = false;
    });

    observeViewerMap(mini, "mini");

    // After every style change on the mini-map all sources/layers/markers are
    // cleared. Redraw from the snapshot in state.miniMapData - needed when
    // ensureMiniMap is called AFTER ensureMap and the style fetch has already
    // completed (applyLoadedStyle was never called for this mini-map instance).
    mini.on("style.load", () => {
        state.miniMapReady = true;
        if (state.miniMapData) refreshMiniMap(state.miniMapData);
    });

    // If the style fetch already completed (typical: ensureMiniMap called after
    // ensureMap and the style resolved), apply the cached style directly.
    // Otherwise do nothing: ensureMap - always called first, and the only reason
    // cached is still null - has a pending loadMapStyle().then(applyLoadedStyle)
    // on the same cached promise, and applyLoadedStyle sets state.miniMap too
    // (assigned synchronously above). Registering our own callback here would
    // just re-apply the same style a second time to both maps (full setStyle
    // diff:false = teardown + re-parse of the heavy style.json).
    const theme = currentMapTheme();
    const provider = getMapProvider();
    const cached = cachedMapStyles.get(styleCacheKey(provider, theme));
    if (cached && state.miniMap) {
        setViewerMapStyle(state.miniMap, applyViewerMapStyle(cached));
        miniMapAttributionControl.setProvider(provider);
    }

    return mini;
}

/**
 * Creates the current-position marker. Every shape points up at bearing=0
 * (north). Rotation is via the --bearing CSS variable on the inner .car-marker.
 * The canvas is filled asynchronously for vehicle assets; the element can be
 * handed to MapLibre immediately and paints in place when its asset is ready.
 */
function buildCarMarkerElement(pitchDeg = 0): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "car-marker-wrap";
    const marker = document.createElement("div");
    marker.className = "car-marker";
    marker.style.setProperty("--bearing", "0deg");
    marker.style.setProperty("--marker-pitch-scale", mapMarkerPitchScale(pitchDeg).toFixed(3));
    const appearance = getMapMarkerAppearance();
    marker.style.setProperty("--map-marker-size", `${MAP_MARKER_SIZE_PX[appearance.size]}px`);
    const canvas = document.createElement("canvas");
    canvas.className = "car-marker__canvas";
    canvas.width = 192;
    canvas.height = 192;
    marker.appendChild(canvas);
    wrap.appendChild(marker);
    void renderMapMarkerIntoCanvas(canvas, appearance, mapMarkerViewForPitch(pitchDeg));
    return wrap;
}

function refreshLiveMapMarkerAppearance(): void {
    const appearance = getMapMarkerAppearance();
    for (const [marker, map] of [
        [state.marker, state.map],
        [state.miniMapMarker, state.miniMap],
    ] as const) {
        const inner = marker?.getElement()?.querySelector<HTMLElement>(".car-marker");
        const canvas = inner?.querySelector<HTMLCanvasElement>(".car-marker__canvas");
        if (!inner || !canvas) continue;
        inner.style.setProperty("--map-marker-size", `${MAP_MARKER_SIZE_PX[appearance.size]}px`);
        void renderMapMarkerIntoCanvas(canvas, appearance, mapMarkerViewForPitch(map?.getPitch() ?? 0));
    }
}

function buildEndpointMarkerElement(kind: "start" | "end"): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "endpoint-marker-wrap";
    wrap.dataset.endpoint = kind;
    wrap.title = t(kind === "start" ? "map.tripStart" : "map.tripEnd");
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", wrap.title);
    const tc = themeColors();
    const isStart = kind === "start";
    const fill = isStart ? tc.markerStart : tc.markerEnd;
    const stroke = viewerMapColors().markerStroke;
    const poleX = isStart ? 27 : 1;
    const flag = isStart
        ? `<path d="M27 3H3L8 11L3 19H27Z" fill="${fill}" stroke="${stroke}"/>`
        : `<path d="M1 3H25V19H1Z" fill="${stroke}"/>
           <path d="M1 3h6v4H1zM13 3h6v4h-6zM7 7h6v4H7zM19 7h6v4h-6zM1 11h6v4H1zM13 11h6v4h-6zM7 15h6v4H7zM19 15h6v4h-6z" fill="${fill}"/>
           <path d="M1 3H25V19H1Z" fill="none" stroke="${stroke}"/>`;
    wrap.innerHTML = `
        <svg viewBox="0 0 28 32" width="28" height="32" aria-hidden="true" stroke-linejoin="round">
            <path d="M${poleX} 2V31" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>
            ${flag}
        </svg>
    `;
    return wrap;
}

function addEndpointMarker(map: maplibregl.Map, kind: "start" | "end", coords: LngLatTuple): maplibregl.Marker {
    // Opposite flag directions keep both endpoints legible when the trip returns to its start.
    const isStart = kind === "start";
    return new mlg!.Marker({
        element: buildEndpointMarkerElement(kind),
        anchor: isStart ? "bottom-right" : "bottom-left",
        offset: [isStart ? 1 : -1, 1],
        rotationAlignment: "viewport",
        pitchAlignment: "viewport",
        subpixelPositioning: true,
    })
        .setLngLat(coords)
        .addTo(map);
}

/** GPS and accelerometer panels stay usable even when WebGL is unavailable. */
function syncMapPanels(trip: Trip | null, recordCount: number): void {
    state.hasTrack = recordCount > 0;
    const hasTelemetry = state.hasTrack || hasAccelData(trip?.records ?? []);
    setPanelAvailable("map", state.hasTrack && state.map !== null);
    setPanelAvailable("chart", hasTelemetry);
    setPanelAvailable("strip", hasTelemetry);
    applyMapLayout();
    callbacks.onChartLayoutChange();
    emitLifecycle("map-tracks-rendered", { recordCount });
}

export function refreshMap(trip: Trip | null, preserveCamera = false): void {
    const map = ensureMap();
    if (!map) {
        // No WebGL: the map can't render, but the chart + inferred strip depend
        // only on GPS data and must still work. Drive their state without
        // touching the (absent) map.
        const records = trip?.records ?? [];
        const hasUsableGps = records.some(isValidGpsFix);
        syncMapPanels(trip, hasUsableGps ? records.length : 0);
        return;
    }
    // style.load permits local source/layer writes. isStyleLoaded(), load and
    // idle also wait for remote resources and must never gate the local track.
    // The style.load handler redraws the current active trip after a swap.
    if (!state.mapReady) return;

    // Remove old delegated listeners BEFORE removing the layer. MapLibre does
    // NOT auto-remove listeners registered via map.on(type, layerId, handler)
    // when the layer is removed - they stay in the internal dispatcher and
    // re-activate when a new layer with the same id is added.
    removeTrackListeners(map);
    removeEventsListeners(map);

    // Drop the cached track scaffolding from the previous trip - the rAF tick
    // skips trail-progress writes when trackTotalDist is 0. Reset the trail
    // delta-guard too, otherwise a new trip whose initial progress happens to
    // match the previous one would skip the first write and leave the overlay
    // stale until 0.5% of the track is driven.
    trackRecs = [];
    trackCumDist = [];
    trackTotalDist = 0;
    trailLastProgressWritten = -1;
    trailLastWriteAt = 0;
    // A pending trailing write carries the OLD trip's progress - it must not
    // land on the new trip's freshly-added trail layer.
    cancelTrailingTrailWrite();
    // Invalidate the follow-camera filter and the applied-target caches: the
    // fitBounds below moves the camera (stepping the filter from the old
    // trip's coordinates would yank it back), and a new trip that starts at
    // the previous trip's exact parking spot must not skip its first write.
    if (!preserveCamera) resetFollowCameraFilter();
    bigMapAppliedLat = Number.NaN;
    bigMapAppliedLon = Number.NaN;
    bigMapAppliedBearing = Number.NaN;
    bigMapAppliedZoom = Number.NaN;
    miniAppliedLat = Number.NaN;
    miniAppliedLon = Number.NaN;
    miniAppliedBearing = Number.NaN;

    const trailLayerId = `${TRIP_SOURCE_ID}${TRAIL_LAYER_SUFFIX}`;
    if (map.getLayer(trailLayerId)) map.removeLayer(trailLayerId);
    removeSpeedTrack(map, TRIP_SOURCE_ID);
    if (state.marker) {
        state.marker.remove();
        state.marker = null;
    }
    if (state.startMarker) {
        state.startMarker.remove();
        state.startMarker = null;
    }
    if (state.endMarker) {
        state.endMarker.remove();
        state.endMarker = null;
    }
    // Hover artifacts must not survive a trip switch. With a mouse the layer
    // mouseleave cleans them on the way out, but on touch (tap shows the
    // popup, no mouseleave ever fires) the old trip's popup stays anchored at
    // stale coords and the chart keeps re-showing the leftover hover cursor.
    if (state.hoverPopup) {
        state.hoverPopup.remove();
        state.hoverPopup = null;
    }
    state.chartHoverX = null;

    const recs = trip?.records ?? [];
    // Active GPS fixes only, in two derived lists:
    //  - activeRecs: every active+finite fix in time order. Drives the trail
    //    progress (below) so its time->distance mapping matches the marker.
    //  - dedupedRecs: activeRecs minus consecutive identical coordinates. They
    //    produce no line segment and break the strictly increasing line-progress
    //    the gradient needs (stationary periods, parallel recordings, etc.), so
    //    only the line geometry + gradient use this list.
    const activeRecs: GpsRecord[] = [];
    const dedupedRecs: GpsRecord[] = [];
    for (const r of recs) {
        if (!isValidGpsFix(r)) continue;
        activeRecs.push(r);
        const last = dedupedRecs[dedupedRecs.length - 1];
        if (!last || last.lat !== r.lat || last.lon !== r.lon) {
            dedupedRecs.push(r);
        }
    }
    if (dedupedRecs.length === 0) {
        syncGpsStatus(true);
        renderedMapTrack = null;
        // No GPS - clear mini-map too (otherwise the previous trip's track stays).
        // hasTrack=false hides both maps and the icon via applyMapLayout.
        // refreshEventsLayer(null) drops a stale events source/layer carried
        // over from the previous (GPS-bearing) trip - applyMapLayout only hides
        // the map, the source would stay registered in MapLibre's style.
        refreshEventsLayer(map, null);
        refreshMiniMap(null);
        syncMapPanels(trip, 0);
        return;
    }

    // Keep bounds and geometry in one continuous world copy across ±180°.
    const coords = unwrapTrackCoordinates(dedupedRecs.map((r) => [r.lon, r.lat]));
    const { cumDist, total: totalDist } = buildMercatorCumulativeDistances(dedupedRecs);
    const gradient = buildSpeedGradient(dedupedRecs, cumDist, totalDist);

    // Save for the rAF trail-progress computation. Trail progress runs over
    // activeRecs, NOT dedupedRecs: the marker interpolates the car position over
    // the raw records by time, so during a stop (many same-coordinate fixes) it
    // stays put. dedupedRecs collapses those fixes, so ITS time axis would
    // interpolate the distance toward the next point during the stop - making
    // the dimmed trail run ahead of the marker on stop-and-go routes. activeRecs
    // keeps the stationary fixes, so the time->distance mapping matches the
    // marker. Its cumulative-distance total equals the deduped line length (the
    // dropped segments are zero-length), so the fraction still maps 1:1 onto the
    // line's line-progress.
    const trailProgress = buildMercatorCumulativeDistances(activeRecs);
    trackRecs = activeRecs;
    trackCumDist = trailProgress.cumDist;
    trackTotalDist = trailProgress.total;

    const trackWidth = 4;
    addSpeedTrack(map, { coords, gradient }, { sourceId: TRIP_SOURCE_ID, width: trackWidth, opacity: 0.9 });
    // Trail overlay: same geometry, line-gradient is a 4-stop transparent ->
    // dim mask. setTrailProgress() rewrites it on every rAF tick so the un-
    // driven part of the track fades toward the map background. The driven
    // part stays unveiled - the base layer's speed gradient shines through.
    map.addLayer({
        id: trailLayerId,
        type: "line",
        source: TRIP_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
            "line-width": speedTrackOuterWidth(trackWidth) + 1,
            "line-gradient": [
                "interpolate",
                ["linear"],
                ["line-progress"],
                0,
                viewerMapColors().trackVeil,
                1,
                viewerMapColors().trackVeil,
            ] as never,
        },
    });

    addTrackListeners(map);

    state.marker = new mlg!.Marker({
        element: buildCarMarkerElement(map.getPitch()),
        // "map" alignment: CSS bearing is in map coordinates (from true north).
        // MapLibre auto-counter-rotates the marker when the map rotates, so the
        // arrow always points the correct geographic direction. With "viewport"
        // in rotate mode the arrow would drift sideways relative to the map.
        rotationAlignment: "map",
        // Keep it a viewport billboard, then apply a milder manual perspective
        // scale in setMarkerPitch(). Full map alignment becomes an unreadable
        // sliver at the 58-70° chase angles.
        pitchAlignment: "viewport",
        // Subpixel translate3d on the marker DOM. Without this the marker snaps
        // to whole pixels per frame - visible jitter at slow speeds where the
        // per-frame shift is <1 px.
        subpixelPositioning: true,
    })
        .setLngLat(coords[0]!)
        .addTo(map);
    setMarkerPitch(state.marker, map.getPitch());

    // Fit camera to track bounding box.
    const bounds = coords.reduce((acc, c) => acc.extend(c), new mlg!.LngLatBounds(coords[0]!, coords[0]!));

    state.startMarker = addEndpointMarker(map, "start", coords[0]!);
    state.endMarker = addEndpointMarker(map, "end", coords[coords.length - 1]!);
    if (!preserveCamera) map.fitBounds(bounds, { padding: 40, animate: false });

    // Update mini-map with the already-prepared coords and gradient.
    refreshMiniMap({ coords, gradient });
    syncGpsStatus(currentInterpolatedPosition() !== null);

    // UX-19: event dots on the large map only - mini-map is too small to read them.
    refreshEventsLayer(map, trip);

    syncMapPanels(trip, dedupedRecs.length);
    renderedMapTrack = trip ? { trip, records: trip.records, recordCount: trip.records.length } : null;
    if (!preserveCamera) ensureChaseEngaged();
}

// -- Named handlers for delegated map.on(type, layerId) listeners. -----------
// Must be stable references so map.off() can remove them by identity.

function onTrackEnter(): void {
    state.map?.getCanvas().style.setProperty("cursor", "pointer");
}

function onTrackLeave(): void {
    const map = state.map;
    if (!map) return;
    map.getCanvas().style.cursor = "";
    if (state.hoverPopup) {
        state.hoverPopup.remove();
        state.hoverPopup = null;
    }
    if (state.chartHoverX !== null) {
        state.chartHoverX = null;
        if (state.chart) state.chart.draw();
    }
}

function onEventsEnter(): void {
    state.map?.getCanvas().style.setProperty("cursor", "pointer");
}

function onEventsLeave(): void {
    if (state.map) state.map.getCanvas().style.cursor = "";
}

function onEventsClick(e: maplibregl.MapLayerMouseEvent): void {
    const feat = e.features?.[0];
    if (!feat) return;
    const props = feat.properties as { relSec?: number } | null;
    if (!props || typeof props.relSec !== "number") return;
    callbacks.onSeekTripTime(Math.max(0, props.relSec - 5));
}

function addTrackListeners(map: maplibregl.Map): void {
    map.on("click", TRIP_SOURCE_ID, onTrackClick);
    map.on("mousemove", TRIP_SOURCE_ID, onTrackHover);
    map.on("mouseenter", TRIP_SOURCE_ID, onTrackEnter);
    map.on("mouseleave", TRIP_SOURCE_ID, onTrackLeave);
}

function removeTrackListeners(map: maplibregl.Map): void {
    map.off("click", TRIP_SOURCE_ID, onTrackClick);
    map.off("mousemove", TRIP_SOURCE_ID, onTrackHover);
    map.off("mouseenter", TRIP_SOURCE_ID, onTrackEnter);
    map.off("mouseleave", TRIP_SOURCE_ID, onTrackLeave);
}

function addEventsListeners(map: maplibregl.Map): void {
    map.on("mouseenter", EVENTS_LAYER_ID, onEventsEnter);
    map.on("mouseleave", EVENTS_LAYER_ID, onEventsLeave);
    map.on("click", EVENTS_LAYER_ID, onEventsClick);
}

function removeEventsListeners(map: maplibregl.Map): void {
    map.off("mouseenter", EVENTS_LAYER_ID, onEventsEnter);
    map.off("mouseleave", EVENTS_LAYER_ID, onEventsLeave);
    map.off("click", EVENTS_LAYER_ID, onEventsClick);
}

// UX-19: source/layer IDs for events on the main map.
const EVENTS_SOURCE_ID = "trip-events";
const EVENTS_LAYER_ID = "trip-events-circle";

/**
 * UX-19: draws clickable brake-event dots on top of the track on the large map.
 * Mini-map skips events - density makes them unreadable at small scale.
 * Click seeks to event.relSec - 5 s (same offset as UX-08).
 */
function refreshEventsLayer(map: maplibregl.Map, trip: Trip | null): void {
    removeEventsListeners(map);
    if (map.getLayer(EVENTS_LAYER_ID)) map.removeLayer(EVENTS_LAYER_ID);
    if (map.getSource(EVENTS_SOURCE_ID)) map.removeSource(EVENTS_SOURCE_ID);

    if (!trip || trip.events.length === 0) return;

    // Event coordinates come from the event's own record. Keep an event with
    // no usable position on the timeline, without inventing a location for its pin.
    const features: Array<{
        type: "Feature";
        geometry: { type: "Point"; coordinates: [number, number] };
        properties: { kind: string; relSec: number; severity: number; recordIndex: number };
    }> = [];
    for (const ev of trip.events) {
        const rec = trip.records[ev.recordIndex];
        if (!rec || !isValidGpsFix(rec)) continue;
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [rec.lon, rec.lat] },
            properties: {
                kind: ev.kind,
                relSec: ev.relSec,
                severity: ev.severity,
                recordIndex: ev.recordIndex,
            },
        });
    }
    if (features.length === 0) return;

    map.addSource(EVENTS_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features },
    });
    const tc = themeColors();
    const bgColor = viewerMapColors().background;
    map.addLayer({
        id: EVENTS_LAYER_ID,
        type: "circle",
        source: EVENTS_SOURCE_ID,
        paint: {
            // Radius scales with impact severity (|G|, carried per feature at
            // properties.severity): a harder impact draws a bigger dot - the core
            // signal for a crash viewer. Domain spans from just under the default
            // 0.5g noise floor up to a hard ~1.5g impact; `interpolate` clamps
            // outside it, so a user-raised/lowered detection threshold still
            // renders sensibly. Color stays the fixed --dc-red brake signal -
            // the exact g value already shows in the chart event popup, so a
            // color ramp would only erode the established semantic. Cast `as
            // never` mirrors the line-gradient expression idiom above.
            "circle-radius": ["interpolate", ["linear"], ["get", "severity"], 0.4, 4, 1.5, 8] as never,
            "circle-color": tc.eventBrake,
            "circle-stroke-width": 2,
            "circle-stroke-color": bgColor,
        },
    });

    addEventsListeners(map);
}

/**
 * Updates the track source/layer and car marker on the mini-map. Called from
 * refreshMap on trip change. Accepts already-prepared coords + gradient to
 * avoid re-deduplicating GPS records and diverging from the large map.
 */
function refreshMiniMap(data: MiniMapData | null): void {
    // Store in state so the style.load handler in ensureMiniMap can redraw
    // with the same coords/gradient without touching state.active.
    state.miniMapData = data;

    const mini = ensureMiniMap();
    // No WebGL: no mini-map instance. Nothing to draw - the big-map slot already
    // shows the "map unavailable" notice (see applyMapLayout).
    if (!mini) return;
    // DOM markers survive style changes, including a switch to a trip without GPS.
    if (state.miniMapMarker) {
        state.miniMapMarker.remove();
        state.miniMapMarker = null;
    }
    miniStartMarker?.remove();
    miniEndMarker?.remove();
    miniStartMarker = null;
    miniEndMarker = null;
    if (!state.miniMapReady) return;

    removeSpeedTrack(mini, TRIP_SOURCE_ID);

    if (!data || data.coords.length === 0) return;
    const { coords } = data;

    // Thinner line on mini-map: at small scale a 4 px line turns into a blob.
    addSpeedTrack(mini, data, { sourceId: TRIP_SOURCE_ID, width: 3, opacity: 0.95 });

    state.miniMapMarker = new mlg!.Marker({
        element: buildCarMarkerElement(),
        rotationAlignment: "viewport",
        subpixelPositioning: true,
    })
        .setLngLat(coords[0]!)
        .addTo(mini);
    miniStartMarker = addEndpointMarker(mini, "start", coords[0]!);
    miniEndMarker = addEndpointMarker(mini, "end", coords[coords.length - 1]!);
    syncGpsStatus(currentInterpolatedPosition() !== null);

    // Initial view at the first point; rAF loop will center on current position
    // at the first tick. Invalidate the mini lane's applied-target cache: this
    // function also re-runs from the mini-map's style.load (theme swap), and
    // with an unchanged playhead the change-gate would otherwise skip the next
    // update and leave the camera + marker parked at the trip start.
    mini.jumpTo({ center: coords[0]!, zoom: miniMapZoomForLat(coords[0]![1]), bearing: 0 });
    miniAppliedLat = Number.NaN;
    miniAppliedLon = Number.NaN;
    miniAppliedBearing = Number.NaN;
}

/** Rotates a car marker by updating the --bearing CSS variable on its inner
 *  .car-marker element. No-op when the marker or element is absent. Shared by
 *  the main map and the mini-map (separate Marker instances). */
function rotateMarker(marker: maplibregl.Marker | null, bearingDeg: number): void {
    if (!marker) return;
    const inner = marker.getElement()?.querySelector<HTMLElement>(".car-marker");
    if (!inner) return;
    inner.style.setProperty("--bearing", `${bearingDeg}deg`);
}

function setMarkerPitch(marker: maplibregl.Marker | null, pitchDeg: number): void {
    if (!marker) return;
    const inner = marker.getElement()?.querySelector<HTMLElement>(".car-marker");
    if (!inner) return;
    inner.style.setProperty("--marker-pitch-scale", mapMarkerPitchScale(pitchDeg).toFixed(3));
    const canvas = inner.querySelector<HTMLCanvasElement>(".car-marker__canvas");
    if (!canvas) return;
    const appearance = getMapMarkerAppearance();
    const view = mapMarkerViewForPitch(pitchDeg);
    // Pitch animates every frame; repaint only when the artwork view changes.
    if (canvas.dataset.markerRenderKey !== mapMarkerRenderKey(appearance, view)) {
        void renderMapMarkerIntoCanvas(canvas, appearance, view);
    }
}

/**
 * Hides/shows a marker via CSS visibility (not display:none) so MapLibre keeps
 * it in layout and setLngLat/getElement remain safe. Idempotent.
 */
function setMarkerHidden(m: maplibregl.Marker, hidden: boolean): void {
    const el = m.getElement();
    if (!el) return;
    const visibility = hidden ? "hidden" : "";
    if (el.style.visibility !== visibility) el.style.visibility = visibility;
}

/**
 * Finds the nearest active GPS record in the map's projected coordinate space.
 * Returns the index in trip.records or -1.
 */
function nearestActiveRecordIndex(trip: Trip, lat: number, lng: number): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    const targetY = mercatorY(lat);
    for (let i = 0; i < trip.records.length; i++) {
        const r = trip.records[i]!;
        if (!isValidGpsFix(r)) continue;
        const dLat = mercatorY(r.lat) - targetY;
        const dLon = wrapDegrees(r.lon - lng);
        const d = dLat * dLat + dLon * dLon;
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

/** Track click: seek to the video moment corresponding to the nearest GPS point. */
function onTrackClick(ev: maplibregl.MapMouseEvent): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip || trip.records.length === 0) return;

    const idx = nearestActiveRecordIndex(trip, ev.lngLat.lat, ev.lngLat.lng);
    if (idx === -1) return;
    const rec = trip.records[idx]!;
    // Seek targets are footage-axis seconds; project the record's wall-clock time.
    callbacks.onSeekTripTime(wallToContentSec(trip.timeline, rec.unixSeconds));
}

/**
 * Track hover: shows a popup with time, speed and coordinates for the nearest
 * GPS point. The popup instance is reused (one per state) to avoid DOM churn.
 */
function onTrackHover(ev: maplibregl.MapMouseEvent): void {
    if (!state.active || !state.map) return;
    const trip = state.trips[state.active.trip];
    if (!trip || trip.records.length === 0) return;

    const idx = nearestActiveRecordIndex(trip, ev.lngLat.lat, ev.lngLat.lng);
    if (idx === -1) return;
    const rec = trip.records[idx]!;

    if (!state.hoverPopup) {
        state.hoverPopup = new mlg!.Popup({
            // On touch there is no mouseleave to auto-remove the popup, so without
            // a close button a tapped route popup lingers for the whole trip. Give
            // coarse pointers an explicit dismiss; desktop keeps the clean
            // hover-driven popup (mouseleave still removes it).
            closeButton: isCoarsePointer(),
            closeOnClick: false,
            offset: 12,
            className: "ez-popup",
        });
    }
    state.hoverPopup
        .setLngLat([unwrapLongitude(rec.lon, ev.lngLat.lng), rec.lat])
        .setHTML(buildRecordPopupHtml(rec, trip))
        .addTo(state.map);

    // Sync the chart cursor to the same moment (footage axis, same as chart hover).
    state.chartHoverX = wallToContentSec(trip.timeline, rec.unixSeconds);
    if (state.chart) state.chart.draw();
}

/**
 * Single HTML generator for hover tooltips: shared by the map track popup and
 * the Chart.js external tooltip. One source of truth for content and style.
 */
export function buildRecordPopupHtml(rec: GpsRecord, trip: Trip): string {
    // "rel" label is the footage-axis position (matches the scrubber/chart);
    // "abs" below stays real wall-clock.
    const relSec = wallToContentSec(trip.timeline, rec.unixSeconds);
    // Display clock (camera clock when known) - see displayClockDate contract.
    const absFmt = cachedDateTimeFormat(getDateLocale(), POPUP_CLOCK_FORMAT);
    const titleStr = t("popup.title", {
        rel: formatTime(relSec),
        abs: absFmt.format(displayClockDate(rec.unixSeconds, trip.cameraTzSec)),
    });
    // Show speed in the user-selected units (km/h or mph). The track color
    // gradient is still computed from km/h - we don't shift its breakpoints
    // between units.
    const speedFmt = formatSpeedFromMs(rec.speedMs);
    const speedStr = formatSpeedReading(rec, speedFmt.value);
    const speedUnitKey = speedFmt.unitKey;
    // No accelerometer in this format - drop the G rows entirely rather than
    // show a constant 0.00 (same rule as the hidden |G| curve on the chart).
    const gRows = hasAccelData(trip.records)
        ? `<div class="track-popup-row"><span class="track-popup-label">${t("popup.label.gMag")}</span><span>${formatNumber(gMagnitude(rec), 2)} g</span></div>
            <div class="track-popup-row mono"><span class="track-popup-label">${t("popup.label.aXYZ")}</span><span>${formatNumber(rec.accelXg, 2)} · ${formatNumber(rec.accelYg, 2)} · ${formatNumber(rec.accelZg, 2)}</span></div>`
        : "";
    // mp4Filename is user-controlled (70mai: CSV field[9]; GPX: matched MP4
    // basename; embedded: File.name). The user may have renamed the file to
    // anything, including HTML/JS injection - escape before innerHTML/setHTML.
    const fileRaw = rec.mp4Filename && rec.mp4Filename !== "0" ? rec.mp4Filename : t("popup.placeholder");
    const fileStr = escapeHtml(fileRaw);
    return `
        <div class="track-popup">
            <div class="track-popup-title">${titleStr}</div>
            <div class="track-popup-row"><span class="track-popup-label">${t(rec.speedSource === "estimated" ? "speed.estimated" : "popup.label.speed")}</span><span>${speedStr} ${t(speedUnitKey)}</span></div>
            ${gRows}
            <div class="track-popup-row mono"><span class="track-popup-label">${t("popup.label.coords")}</span><span>${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}</span></div>
            <div class="track-popup-row mono"><span class="track-popup-label">${t("popup.label.file")}</span><span>${fileStr}</span></div>
        </div>
    `;
}

// UX-18: FOLLOW_CYCLE removed - segmented control lets the user pick a mode
// directly without cycling.

/**
 * Real UTC for the player's current position. Both native and per-file MSE
 * backends present file-relative currentTime; an interval may start later
 * inside that file when the cameras cut at different times.
 */
function currentRealUtc(frame: TripFrame): number {
    const ct = dom.player.currentTime || 0;
    return frame.startUtc + ct - frameMediaOffset(frame, effectiveMasterChannel());
}

/**
 * Returns the interpolated position for the current player currentTime.
 * Shared by the rAF loop and the follow-mode switch so they get the same point.
 */
function currentInterpolatedPosition(): {
    lat: number;
    lon: number;
    bearingDeg: number;
    speedMs: number;
} | null {
    const af = activeFrame();
    if (!af || af.trip.records.length === 0) return null;
    return mapPositionAt(af.trip.records, currentRealUtc(af.frame));
}

export function syncMapFollowButton(): void {
    syncMapCompassAvailability();
    // UX-18: 3-button segmented control; active mode highlighted via
    // [aria-pressed="true"] (see CSS .map-follow-seg[aria-pressed="true"]).
    if (!dom.mapFollowSegments) return;
    const buttons = dom.mapFollowSegments.querySelectorAll<HTMLButtonElement>(".map-follow-seg");
    for (const btn of buttons) {
        const mode = btn.dataset.followMode as FollowMode | undefined;
        if (!mode) continue;
        btn.disabled = !MAP_PROVIDER_REGISTRY[getMapProvider()].camera.supportsHeadingUp && isHeadingUpMode(mode);
        btn.setAttribute("aria-pressed", mode === state.followMode ? "true" : "false");
    }
    syncChaseControls();
}

/**
 * Smoothly moves the camera to the current car position. Used on file boundary
 * within a trip to avoid a hard jump.
 */
export function smoothCameraToCurrentPosition(): void {
    // Only animate when follow is on; in "off" mode the user controls the view
    // and an automatic camera move on file change would be intrusive.
    if (!state.map || state.followMode === "off") return;
    const pos = currentInterpolatedPosition();
    if (!pos) return;
    const duration = 250;
    const opts: maplibregl.EaseToOptions = { center: [pos.lon, pos.lat], duration };
    if (isHeadingUpMode(state.followMode)) {
        opts.bearing = pos.bearingDeg;
    }
    suspendFollowEase(duration);
    state.map.easeTo(opts);
}

/** Applies a follow-mode transition. Extracted from the segmented-control click
 *  so the recenter "resume" path can reuse the exact same camera logic. Sets
 *  state, syncs the control + the resolution cap, then runs the one-off ease /
 *  chase entry toward the current car. */
function applyFollowMode(mode: FollowMode): void {
    if (!MAP_PROVIDER_REGISTRY[getMapProvider()].camera.supportsHeadingUp && isHeadingUpMode(mode)) return;
    const fromMode = state.followMode;
    if (fromMode === mode) return;
    state.followMode = mode;
    // A deliberate mode pick cancels any pending post-interaction grace window (and
    // its resume latch) so the new mode engages now, not after the leftover seconds
    // - and the follow loop does not fire a spurious re-aim on top of this switch.
    resetFollowInteractionPause();
    syncMapFollowButton();
    syncBigMapPixelRatio();
    const map = state.map;
    if (!map) return;
    // Whether chase VISUALS (tilt + 3D buildings) are currently on screen. Keyed
    // on the actual map pitch, NOT fromMode === "chase": a user gesture can break
    // chase to "off" while deliberately keeping the tilt + buildings, so a later
    // switch to follow/rotate must still tear them down even though fromMode is
    // now "off".
    const chaseVisualsActive = map.getPitch() > 1;
    if (mode !== "chase" && chaseVisualsActive) leaveChaseCamera(map);
    const pos = currentInterpolatedPosition();
    if (mode === "chase") {
        enterChaseCamera(map, pos);
        return;
    }
    const duration = 300;
    const opts: maplibregl.EaseToOptions = { duration };
    // "off" keeps the user's view; follow/rotate snap to the car.
    if (mode !== "off" && pos) {
        opts.center = [pos.lon, pos.lat];
        if (isHeadingUpMode(mode)) opts.bearing = pos.bearingDeg;
    }
    // Un-tilt back to flat when leaving a tilted (chase / broken-chase) state.
    if (chaseVisualsActive) opts.pitch = 0;
    // "follow" is north-up by definition - reset bearing when coming from a
    // heading-up mode OR when the map is currently rotated (e.g. broken chase).
    if (mode === "follow" && (isHeadingUpMode(fromMode) || Math.abs(map.getBearing()) > 0.5)) opts.bearing = 0;
    // Nothing to animate (e.g. off<-follow with no recenter) - skip the ease.
    if (opts.center === undefined && opts.pitch === undefined && opts.bearing === undefined) return;
    suspendFollowEase(duration);
    map.easeTo(opts);
}

/** Clears any pending post-interaction grace window + the "user is steering"
 *  latch. Called on trip change so a pause armed in one trip does not carry its
 *  follow-resume re-aim into the next. followMode itself is a persistent map
 *  preference and is intentionally NOT reset. */
export function resetFollowInteractionPause(): void {
    followResumeRemainingMs = 0;
    followWasUserPaused = false;
}

// --- map expanded / collapsed ---
//
// State flags:
//   - state.hasTrack    - active GPS points exist
//   - state.mapExpanded - large map is shown beside the video
//
// The View menu exposes the combined state as off / mini / large. The persisted
// on/off preference still lives in localStorage["dc.viewer.panels"].map;
// state.mapExpanded distinguishes mini from large during the current session.
// Every entry point below commits through setMapViewMode so controls, layout and
// shared-element animations stay in sync.

// Vector follow views trade some pixel density for playback GPU headroom.
const BIG_MAP_FOLLOW_PIXEL_RATIO_CAP = 1.5;
let bigMapPixelRatioApplied = Number.NaN;

/**
 * Raster labels are already baked into tiles, so another downsample softens
 * them. Keep raster maps and paused inspection at full resolution; cap only
 * vector playback. Avoid redundant GL backing-store resizes.
 */
function syncBigMapPixelRatio(): void {
    const map = state.map;
    if (!map) return;
    const dpr = window.devicePixelRatio || 1;
    const bigMapShown = state.hasTrack && state.mapExpanded && getViewPanels().map && !state.exportModeOpen;
    const shouldCap =
        bigMapShown &&
        state.followMode !== "off" &&
        MAP_PROVIDER_REGISTRY[getMapProvider()].tileType === "vector" &&
        !dom.player.paused &&
        !dom.player.ended;
    const target = shouldCap ? Math.min(dpr, BIG_MAP_FOLLOW_PIXEL_RATIO_CAP) : dpr;
    if (target === bigMapPixelRatioApplied) return;
    bigMapPixelRatioApplied = target;
    map.setPixelRatio(target);
}

export function applyMapLayout(): void {
    syncMobileViewNav();
    // No WebGL: there is no map to lay out. Use the big-map slot to host the
    // permanent "map unavailable" notice (it has no canvas) whenever GPS exists
    // and the user wants a map; the mini-map and the toggles are hidden
    // via body.map-unavailable in CSS. The chart keeps its own layout.
    if (!isMapAvailable()) {
        // Export mode suppresses the notice pane exactly like it suppresses the
        // real map below: the export grid templates rely on .map-expanded never
        // coexisting with body.export-mode (see the trim-row overrides in
        // viewer.css), and without this term this branch would be the one path
        // that breaks that invariant. Restored on close via the same recompute.
        const showNotice = state.hasTrack && getViewPanels().map && !state.exportModeOpen;
        dom.playerWrap.classList.toggle("map-expanded", showNotice);
        dom.miniMap.hidden = true;
        dom.miniMapClose.hidden = true;
        dom.mapCollapseBtn.hidden = true;
        dom.playerMapBtn.disabled = true;
        syncMapModeControl(currentMapViewMode());
        return;
    }
    // Mini-map visibility = GPS available AND not in expanded mode AND user
    // hasn't hidden it via the "View" menu. View-menu writes the `hidden`
    // attribute on dom.miniMap directly; we re-apply here so the same state
    // also drives expanded-mode toggling and trip switches.
    //
    // Export mode hides both the big map and the mini-map: while configuring an
    // export the player is the WYSIWYG preview of the burned-in overlays (incl.
    // its own map mini-overlay), so the viewer's live map/mini-map only add
    // clutter. We suppress DISPLAY only - mapExpanded and the View-menu pref are
    // left untouched, so closing export restores exactly the prior layout via
    // the same recompute (subscribeExportState -> applyMapLayout).
    const exportSuppressed = state.exportModeOpen;
    const userWantsMap = getViewPanels().map;
    const showBigMap = state.hasTrack && state.mapExpanded && userWantsMap && !exportSuppressed;
    const showMini = state.hasTrack && !state.mapExpanded && userWantsMap && !exportSuppressed;

    // Update class first so the grid reflows immediately.
    dom.playerWrap.classList.toggle("map-expanded", showBigMap);

    dom.miniMap.hidden = !showMini;
    ensureMarkerLoop();
    // Close-X follows the mini-map - if there's no map to close, no button.
    dom.miniMapClose.hidden = !showMini;
    dom.mapCollapseBtn.hidden = !showBigMap;

    // Player-bar map toggle: mobile-only entry to expand/collapse the map
    // (mini-map is hidden on mobile - see map.css). Disabled only when
    // there is no GPS - userWantsMap is intentionally not a disable condition
    // because the View menu sits inside the overflow kebab on mobile and is a
    // discoverability dead-end; the click handler force-enables map visibility
    // so this button is a true single-tap entry point.
    dom.playerMapBtn.disabled = !state.hasTrack || exportSuppressed;
    const playerMapLabel = showBigMap ? t("map.collapse") : t("miniMap.expandAria");
    dom.playerMapBtn.setAttribute("aria-label", playerMapLabel);
    dom.playerMapBtn.title = playerMapLabel;
    dom.playerMapBtn.setAttribute("aria-pressed", showBigMap ? "true" : "false");
    syncMapModeControl(currentMapViewMode());

    // Apply the resolution policy before resizing so both changes settle together.
    syncBigMapPixelRatio();

    // MapLibre does not observe CSS container size changes. resize() is required
    // after layout change, otherwise the canvas keeps the old pixel dimensions.
    requestAnimationFrame(() => {
        if (state.map && showBigMap) state.map.resize();
        if (state.miniMap && showMini) state.miniMap.resize();
    });
}

const MAP_MORPH_DURATION_MS = 320;
let mapMorphRunning = false;
let pendingMapModeRequest: { mode: MapViewMode; control: HTMLElement } | null = null;

function currentMapViewMode(): MapViewMode {
    if (!getViewPanels().map) return "off";
    if (state.mapExpanded) return "large";
    // The mini-map is deliberately absent on phones. Treat the collapsed
    // state as off there so the View control never claims an invisible mode.
    return isMobileLayout() ? "off" : "mini";
}

function commitMapViewMode(mode: MapViewMode): void {
    state.mapExpanded = mode === "large";
    setMapViewModePreference(mode);
    applyMapLayout();
    if (mode === "large") {
        // Default follow mode is chase. Idempotent (pitch-guarded), so showing
        // the large map again does not restart the camera ease unnecessarily.
        ensureChaseEngaged();
    }
}

function surfaceForMapMode(mode: MapViewMode): HTMLElement | null {
    if (mode === "mini") return dom.miniMap;
    if (mode === "large") return dom.mapWrap;
    return null;
}

function restoreInlineStyle(element: HTMLElement, style: string | null): void {
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
}

function finishMapMorph(): void {
    mapMorphRunning = false;
    document.body.classList.remove("map-morphing");
    const pending = pendingMapModeRequest;
    pendingMapModeRequest = null;
    if (pending) queueMicrotask(() => setMapViewMode(pending.mode, pending.control));
}

/** Keeps the live MapLibre surface on screen as a fixed overlay while the real
 *  layout changes underneath it, then maps its measured rectangle onto the
 *  destination. Because this animates the real canvas (not cloneNode's blank
 *  canvas), route and marker continuity survive mini ↔ large transitions. */
function morphMapSurface(
    source: HTMLElement,
    target: HTMLElement,
    applyFinalLayout: () => void,
    fadeTarget: boolean,
): void {
    const fromRect = source.getBoundingClientRect();
    const targetStyle = target.getAttribute("style");
    const sourceStyle = source.getAttribute("style");
    if (prefersReducedMotion() || typeof source.animate !== "function" || fromRect.width === 0) {
        applyFinalLayout();
        return;
    }

    const fromRadius = getComputedStyle(source).borderRadius;
    source.style.position = "fixed";
    source.style.inset = "auto";
    source.style.left = `${fromRect.left}px`;
    source.style.top = `${fromRect.top}px`;
    source.style.width = `${fromRect.width}px`;
    source.style.height = `${fromRect.height}px`;
    source.style.margin = "0";
    source.style.transform = "none";
    source.style.transformOrigin = "0 0";
    source.style.zIndex = "var(--dc-z-modal)";
    source.style.pointerEvents = "none";
    source.style.overflow = "hidden";
    source.style.display = "block";
    if (fadeTarget) target.style.opacity = "0";

    applyFinalLayout();
    // applyMapLayout hides the old surface as part of the final state. The
    // promoted fixed overlay must remain visible only for the animation run.
    source.hidden = false;
    source.style.display = "block";
    const toRect = target.getBoundingClientRect();
    if (toRect.width === 0 || toRect.height === 0) {
        restoreInlineStyle(source, sourceStyle);
        restoreInlineStyle(target, targetStyle);
        applyFinalLayout();
        return;
    }

    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;
    const sx = toRect.width / fromRect.width;
    const sy = toRect.height / fromRect.height;
    const toRadius = getComputedStyle(target).borderRadius;
    mapMorphRunning = true;
    document.body.classList.add("map-morphing");
    const sourceAnimation = source.animate(
        [
            { transform: "translate(0, 0) scale(1)", borderRadius: fromRadius, opacity: 1, offset: 0 },
            { opacity: 1, offset: 0.72 },
            {
                transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
                borderRadius: toRadius,
                opacity: fadeTarget ? 0 : 0.12,
                offset: 1,
            },
        ],
        { duration: MAP_MORPH_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    const targetAnimation = fadeTarget
        ? target.animate([{ opacity: 0 }, { opacity: 0, offset: 0.62 }, { opacity: 1 }], {
              duration: MAP_MORPH_DURATION_MS,
              easing: "ease-out",
              fill: "forwards",
          })
        : null;

    let settled = false;
    const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        // `fill:forwards` otherwise keeps the animation-origin opacity/transform
        // above the restored CSS forever. The next time this same MapLibre
        // surface is shown it would occupy layout but remain transparent.
        if (sourceAnimation.playState !== "idle") sourceAnimation.cancel();
        targetAnimation?.cancel();
        restoreInlineStyle(source, sourceStyle);
        restoreInlineStyle(target, targetStyle);
        applyFinalLayout();
        finishMapMorph();
    };
    sourceAnimation.addEventListener("finish", settle);
    sourceAnimation.addEventListener("cancel", settle);
    const timeout = setTimeout(settle, MAP_MORPH_DURATION_MS + 80);
}

/** Opens a map out of the control that requested it. A small map portal grows
 *  from the View/mobile-map button while the destination MapLibre surface fades
 *  in underneath, avoiding a stretched toolbar label. */
function morphMapFromControl(control: HTMLElement, target: HTMLElement, applyFinalLayout: () => void): void {
    const fromRect = control.getBoundingClientRect();
    const targetStyle = target.getAttribute("style");
    if (prefersReducedMotion() || typeof target.animate !== "function" || fromRect.width === 0) {
        applyFinalLayout();
        return;
    }

    target.style.opacity = "0";
    applyFinalLayout();
    const toRect = target.getBoundingClientRect();
    if (toRect.width === 0 || toRect.height === 0) {
        restoreInlineStyle(target, targetStyle);
        applyFinalLayout();
        return;
    }

    const portal = document.createElement("div");
    portal.className = "map-morph-portal";
    portal.setAttribute("aria-hidden", "true");
    const icon = dom.playerMapBtn.querySelector("svg")?.cloneNode(true);
    if (icon) portal.appendChild(icon);
    Object.assign(portal.style, {
        left: `${fromRect.left}px`,
        top: `${fromRect.top}px`,
        width: `${fromRect.width}px`,
        height: `${fromRect.height}px`,
    });
    document.body.appendChild(portal);

    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;
    const sx = toRect.width / fromRect.width;
    const sy = toRect.height / fromRect.height;
    mapMorphRunning = true;
    document.body.classList.add("map-morphing");
    const portalAnimation = portal.animate(
        [
            { transform: "translate(0, 0) scale(1)", opacity: 0.92, borderRadius: "8px", offset: 0 },
            { opacity: 0.78, offset: 0.62 },
            {
                transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
                opacity: 0,
                borderRadius: getComputedStyle(target).borderRadius,
                offset: 1,
            },
        ],
        { duration: MAP_MORPH_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    const targetAnimation = target.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], {
        duration: MAP_MORPH_DURATION_MS,
        easing: "ease-out",
        fill: "forwards",
    });

    let settled = false;
    const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        targetAnimation.cancel();
        portal.remove();
        restoreInlineStyle(target, targetStyle);
        applyFinalLayout();
        finishMapMorph();
    };
    portalAnimation.addEventListener("finish", settle);
    portalAnimation.addEventListener("cancel", settle);
    const timeout = setTimeout(settle, MAP_MORPH_DURATION_MS + 80);
}

function setMapViewMode(mode: MapViewMode, control: HTMLElement = dom.viewMenuButton): void {
    if (!state.hasTrack) return;
    if (mapMorphRunning) {
        pendingMapModeRequest = { mode, control };
        return;
    }
    // Mini is not a renderable mode on phones; M and programmatic requests use
    // the large map there, matching the dedicated toolbar button's behaviour.
    const nextMode = mode === "mini" && isMobileLayout() ? "large" : mode;
    const previousMode = currentMapViewMode();
    if (previousMode === nextMode) return;
    const applyFinalLayout = (): void => commitMapViewMode(nextMode);
    const source = surfaceForMapMode(previousMode);
    const target = surfaceForMapMode(nextMode);

    if (source && target) {
        dom.miniMapClose.hidden = true;
        morphMapSurface(source, target, applyFinalLayout, true);
        return;
    }
    if (source) {
        dom.miniMapClose.hidden = true;
        morphMapSurface(source, control, applyFinalLayout, false);
        return;
    }
    if (target) {
        morphMapFromControl(control, target, applyFinalLayout);
        return;
    }
    applyFinalLayout();
}

function expandMap(control: HTMLElement = dom.miniMap): void {
    setMapViewMode("large", control);
}

function collapseMap(control: HTMLElement = dom.viewMenuButton): void {
    if (!state.mapExpanded) return;
    if (isMobileLayout()) setMapViewMode("off", control);
    else setMapViewMode("mini", control);
}

function closeMiniMapToViewMenu(): void {
    setMapViewMode("off", dom.viewMenuButton);
}

// Mini-map position persisted as proportions of drag-range (frame - mini -
// 2*padding) so the relative position survives viewport size changes between
// sessions. Single JSON key for atomic read/write.
const MINIMAP_POS_STORAGE_KEY = "everydashcam:minimap-pos";
const MINIMAP_PADDING_PX = 16;

interface MiniMapStoredPos {
    xPct: number;
    yPct: number;
}

function loadStoredMiniMapPos(): MiniMapStoredPos | null {
    const parsed = readLocalStorageJson(MINIMAP_POS_STORAGE_KEY);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as { xPct?: unknown; yPct?: unknown };
    const xPct = typeof obj.xPct === "number" && Number.isFinite(obj.xPct) ? obj.xPct : null;
    const yPct = typeof obj.yPct === "number" && Number.isFinite(obj.yPct) ? obj.yPct : null;
    if (xPct === null || yPct === null) return null;
    return { xPct: Math.max(0, Math.min(1, xPct)), yPct: Math.max(0, Math.min(1, yPct)) };
}

function persistMiniMapPos(pos: MiniMapStoredPos): void {
    writeLocalStorageJson(MINIMAP_POS_STORAGE_KEY, pos);
}

/**
 * Drag range for the mini-map in the current frame size: 0..(frame - mini -
 * 2*padding). Returns 0 if the frame has no dimensions yet (pre-first-paint) or
 * is too small; applyOffset clamps to 0 in that case.
 */
function dragRangeForFrame(frame: HTMLElement): { rangeX: number; rangeY: number } {
    const fr = frame.getBoundingClientRect();
    const rangeX = Math.max(0, fr.width - dom.miniMap.offsetWidth - MINIMAP_PADDING_PX * 2);
    const rangeY = Math.max(0, fr.height - dom.miniMap.offsetHeight - MINIMAP_PADDING_PX * 2);
    return { rangeX, rangeY };
}

function initMiniMapDrag(): void {
    // Click expands the large map; Enter/Space for keyboard accessibility
    // (the mini-map group is focusable). The close button is a sibling,
    // not a child, so its click does not bubble through the mini-map.
    //
    // Drag: pointer events on the element. Movement above threshold suppresses
    // the subsequent click to prevent accidental map expand on drag release.
    // Offset is kept in JS and applied via CSS vars --mini-map-offset-x/y to
    // both the mini-map and close button (siblings). Persisted as proportions
    // {xPct, yPct} of drag-range for viewport-size independence.
    const DRAG_THRESHOLD_PX = 5;
    let dragging = false;
    let suppressNextClick = false;
    let startClientX = 0,
        startClientY = 0;
    let baseOffsetX = 0,
        baseOffsetY = 0;
    let appliedOffsetX = 0,
        appliedOffsetY = 0;

    function writeCssOffset(x: number, y: number): void {
        const root = document.documentElement.style;
        root.setProperty("--mini-map-offset-x", `${x}px`);
        root.setProperty("--mini-map-offset-y", `${y}px`);
    }

    /**
     * Applies an absolute offset (from the left:16/top:16 anchor) clamped to the
     * frame bounds. Returns 0 if the frame has no dimensions yet.
     */
    function applyOffset(x: number, y: number, persist: boolean): void {
        const frame = dom.miniMap.parentElement;
        if (!frame) return;
        const { rangeX, rangeY } = dragRangeForFrame(frame);
        const cx = Math.max(0, Math.min(rangeX, x));
        const cy = Math.max(0, Math.min(rangeY, y));
        appliedOffsetX = cx;
        appliedOffsetY = cy;
        writeCssOffset(cx, cy);
        if (persist) {
            const xPct = rangeX > 0 ? cx / rangeX : 0;
            const yPct = rangeY > 0 ? cy / rangeY : 0;
            persistMiniMapPos({ xPct, yPct });
        }
    }

    /**
     * Restores position from localStorage scaled to the current drag-range.
     * Called on init and on each ResizeObserver frame-resize event so the
     * relative position is preserved when the window is resized.
     */
    function applyFromStorage(): void {
        const frame = dom.miniMap.parentElement;
        if (!frame) return;
        const stored = loadStoredMiniMapPos();
        const { rangeX, rangeY } = dragRangeForFrame(frame);
        if (!stored) {
            applyOffset(0, 0, false);
            return;
        }
        applyOffset(stored.xPct * rangeX, stored.yPct * rangeY, false);
    }

    // Initial apply - frame may have no dimensions yet (viewer is display:none
    // on the landing page). ResizeObserver will re-apply once dimensions appear.
    applyFromStorage();
    if (typeof ResizeObserver === "function") {
        const frame = dom.miniMap.parentElement;
        if (frame) {
            const ro = new ResizeObserver(() => {
                if (dragging) return; // don't reposition while the user is dragging
                applyFromStorage();
            });
            ro.observe(frame);
        }
    }

    attachPointerDrag(dom.miniMap, {
        onStart: (e) => {
            if (e.target instanceof Element && e.target.closest("a")) return false;
            dragging = true;
            suppressNextClick = false;
            startClientX = e.clientX;
            startClientY = e.clientY;
            baseOffsetX = appliedOffsetX;
            baseOffsetY = appliedOffsetY;
            dom.miniMap.classList.add("is-dragging");
            return true;
        },
        onMove: (e) => {
            const dx = e.clientX - startClientX;
            const dy = e.clientY - startClientY;
            if (!suppressNextClick && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
                suppressNextClick = true;
            }
            // No persist during drag (writes on every pointermove would thrash
            // localStorage); final persist happens on pointerup.
            applyOffset(baseOffsetX + dx, baseOffsetY + dy, false);
        },
        onEnd: () => {
            dragging = false;
            dom.miniMap.classList.remove("is-dragging");
            applyOffset(appliedOffsetX, appliedOffsetY, true);
        },
    });

    dom.miniMap.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest("a")) return;
        if (suppressNextClick) {
            // This was a drag, not a click - suppress map expand.
            suppressNextClick = false;
            e.stopPropagation();
            return;
        }
        expandMap();
    });

    dom.miniMap.addEventListener("keydown", (e) => {
        if (e.target !== dom.miniMap) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            expandMap();
        }
    });
}

/**
 * Mini-map hover sync: while the cursor is over the mini-map, project the
 * pixel coord to LngLat, snap to the nearest GPS record, and drive the chart
 * cursor. Mirrors what onTrackHover does on the main map but without a popup
 * (the thumbnail is too small to read one). interactive:false on the
 * mini-map blocks MapLibre's own listeners; we attach to the DOM container
 * directly and use mini.unproject() for coordinate conversion.
 */
function initMiniMapHover(): void {
    let lastHoverIdx = -1;
    dom.miniMap.addEventListener("pointermove", (e) => {
        // Drag of the mini-map widget (positioning) takes priority over
        // hover - is-dragging class is added on pointerdown in initMiniMapDrag.
        if (dom.miniMap.classList.contains("is-dragging")) return;
        if (!state.active || !state.miniMap) return;
        const trip = state.trips[state.active.trip];
        if (!trip || trip.records.length === 0) return;
        const rect = dom.miniMap.getBoundingClientRect();
        const lngLat = state.miniMap.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        const idx = nearestActiveRecordIndex(trip, lngLat.lat, lngLat.lng);
        if (idx === -1 || idx === lastHoverIdx) return;
        lastHoverIdx = idx;
        const rec = trip.records[idx]!;
        state.chartHoverX = wallToContentSec(trip.timeline, rec.unixSeconds);
        if (state.chart) state.chart.draw();
    });
    dom.miniMap.addEventListener("pointerleave", () => {
        lastHoverIdx = -1;
        if (state.chartHoverX !== null) {
            state.chartHoverX = null;
            if (state.chart) state.chart.draw();
        }
    });
}

// rAF loop: recalculates marker position and bearing on each frame via linear
// interpolation between adjacent GPS points. Produces smooth movement despite
// 1 Hz GPS log rate. rAF is used instead of setInterval because it is synced to
// the monitor refresh rate, does not steal render frames, and pauses in background
// tabs (CPU savings). Text metrics are updated via timeupdate instead - no point
// writing to the DOM at 60 Hz.
//
// Following modes (follow / rotate / chase) sample presented video frames, so
// the camera and marker move once per decoded frame rather than once per
// display refresh; other visible motion uses rAF. Idle/hidden maps only need
// the drift-sync cadence.
// Media events wake a sleeping loop immediately for playback and paused seeks.
let markerRafHandle: number | null = null;
let markerTimerHandle: ReturnType<typeof setTimeout> | null = null;

const DRIFT_SYNC_INTERVAL_MS = 200;
let slowLaneLastMs = 0;
// Previous fast-lane timestamp, for the filter's frame dt.
let lastFrameMs = 0;

let followRenderCadence: MapRenderCadence | null = null;
let followAppliedFrame: PlayerFrameObservation | null = null;
let followAppliedVideo: HTMLVideoElement | null = null;

function followVideoFrame(now: number): PlayerFrameObservation | null {
    const map = state.map;
    const video = dom.player;
    if (
        !followRenderCadence?.enabled ||
        !map ||
        !state.mapReady ||
        !state.hasTrack ||
        !state.mapExpanded ||
        !getViewPanels().map ||
        state.followMode === "off" ||
        state.exportModeOpen ||
        state.transcodeInProgress ||
        document.hidden ||
        video.paused ||
        video.ended ||
        video.seeking ||
        video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
        map.isMoving() ||
        activeMapGestures.size > 0 ||
        followResumeRemainingMs > 0 ||
        now < followEaseSuspendedUntilMs
    )
        return null;
    const frame = videoPresentedFrame(video);
    // Release deferred paints when frame callbacks stop, including a stalled
    // decoder. The scheduler keeps checking while a paint is pending.
    return frame && now - frame.observedAtMs < 250 ? frame : null;
}

// Camera drive: direct jumpTo with an exponential follow filter. Chaining
// easeTo fully restarts its tween on every call (easeId only suppresses
// the event churn, it does not blend animations): camera velocity stepped at
// every tick seam, the camera trailed the marker by one tick interval, and a
// late rAF tick let the ease finish early - a visible micro-freeze. Driving the
// transform directly each frame removes the seams and the lag; the exponential
// filter below supplies the smoothing the ease used to provide, and keeps
// camera motion continuous across 1 Hz GPS record boundaries, where linear
// interpolation kinks.

// Time constants of the exponential follow filter (how far the camera lags the
// raw interpolated position). Small enough to feel attached to the car, large
// enough to swallow per-record velocity kinks and GPS bearing noise. Divided by
// the playback rate in the step so the SPATIAL lag stays bounded at 2x-8x.
const FOLLOW_CENTER_TAU_MS = 150;
const FOLLOW_BEARING_TAU_MS = 180;
const FOLLOW_ZOOM_TAU_MS = 250;

// Convergence thresholds: when the filter is this close to its target it snaps
// exactly onto it and the per-frame jumpTo stops - the map goes fully idle on a
// paused/stopped playhead. Critical: jumpTo unconditionally fires move events
// and a repaint even for an identical transform, so calling it every frame
// would keep the map rendering at 60 Hz for nothing. 1e-7 deg is ~1 cm - far
// below a visible pixel at any zoom; the chase adaptive zoom EMA converges
// asymptotically, so without the zoom snap the map could not idle for ~10-20 s
// after every pause.
const FOLLOW_SNAP_DEG = 1e-7;
const FOLLOW_SNAP_BEARING_DEG = 0.01;
const FOLLOW_SNAP_ZOOM = 0.001;

// Teleport guard: a seek can move the target across the whole map; gliding
// there through the filter would sweep the camera over every tile in between
// (a transient tile-fetch storm for ~half a second). Beyond ~1.5 viewports of
// ground distance - or a multi-level zoom gap - snap the filter straight onto
// the target instead.
const FOLLOW_TELEPORT_VIEWPORTS = 1.5;
const FOLLOW_TELEPORT_ZOOM_LEVELS = 3;

// Big-map container size in CSS px, cached because reading clientWidth inside
// the follow loop forces a synchronous layout every frame (the marker DOM
// transform is written just before). Refreshed on the map's resize event -
// MapLibre fires it for both window resizes and programmatic map.resize().
let bigMapViewportPx = 1;

// Filtered camera state. NaN = unseeded: the next follow frame seeds it from
// the live camera, so the glide always starts from what the user actually sees
// (after a one-off ease, a user gesture, a trip switch). Bearing is kept
// UNWRAPPED (continuous) so the filter never takes the long way around 360.
let followCamLat = Number.NaN;
let followCamLon = Number.NaN;
let followCamBearing = Number.NaN;
let followCamZoom = Number.NaN;
// True once the filter snapped onto an unchanged target - lets the fast lane
// skip the whole camera step (and its jumpTo) until the target moves again.
let followFilterConverged = false;

/** Invalidates the filtered follow-camera state so the next follow frame
 *  reseeds from the live camera. Called whenever something else moved the
 *  camera (one-off ease via suspendFollowEase, trip switch): stepping the
 *  filter from its stale state would yank the view back to wherever the
 *  filter last was. */
function resetFollowCameraFilter(): void {
    followCamLat = Number.NaN;
    followCamLon = Number.NaN;
    followCamBearing = Number.NaN;
    followCamZoom = Number.NaN;
    followFilterConverged = false;
}

// Last raw follow target (marker + camera goal). A static playhead yields a
// byte-identical interpolated pos (interpolatePosition is deterministic), so an
// exact compare against these reliably detects "nothing moved" and skips the
// marker/trail writes. NaN seeds force the first tick to apply.
let bigMapAppliedLat = Number.NaN;
let bigMapAppliedLon = Number.NaN;
let bigMapAppliedBearing = Number.NaN;
let bigMapAppliedZoom = Number.NaN;
// Same idea for the mini-map (its lane is independent: the big-map vars are
// not updated while the big map is collapsed).
let miniAppliedLat = Number.NaN;
let miniAppliedLon = Number.NaN;
let miniAppliedBearing = Number.NaN;

/**
 * One per-frame step of the follow camera: exponential glide of center /
 * bearing / (chase adaptive) zoom toward the raw interpolated position, applied
 * with a single jumpTo. Snaps and flags convergence when close enough, so the
 * caller stops invoking it and the map idles.
 */
function stepFollowCamera(
    map: maplibregl.Map,
    pos: { lat: number; lon: number; bearingDeg: number; speedMs: number },
    zoomTarget: number | undefined,
    headingUp: boolean,
    frameDtMs: number,
): void {
    if (Number.isNaN(followCamLat)) {
        const center = map.getCenter();
        followCamLat = center.lat;
        followCamLon = center.lng;
        followCamBearing = map.getBearing();
        followCamZoom = map.getZoom();
    }

    // Teleport check on GROUND distance in mercator units converted to px at
    // the filter zoom - deliberately NOT map.project(): the screen projection
    // is useless as a distance metric under the pitched chase camera (forward
    // points saturate at the horizon offset, behind-camera points mirror to
    // bounded coordinates), so a project()-based guard never fires at pitch.
    // The mercator math is orientation-independent and allocation-free.
    // A large zoom gap is a teleport too: gliding zoom across many levels
    // (trip switch lands on a fitBounds overview) sweeps every intermediate
    // tile level for no visual benefit.
    const targetLon = unwrapLongitude(pos.lon, followCamLon);
    const groundPx =
        Math.hypot(targetLon - followCamLon, mercatorY(pos.lat) - mercatorY(followCamLat)) *
        ((MAPLIBRE_TILE_SIZE_PX * 2 ** followCamZoom) / 360);
    const zoomGap = zoomTarget === undefined ? 0 : Math.abs(zoomTarget - followCamZoom);
    const farTeleport =
        groundPx > bigMapViewportPx * FOLLOW_TELEPORT_VIEWPORTS || zoomGap > FOLLOW_TELEPORT_ZOOM_LEVELS;

    if (farTeleport) {
        followCamLat = pos.lat;
        followCamLon = targetLon;
        followCamBearing = pos.bearingDeg;
        if (zoomTarget !== undefined) followCamZoom = zoomTarget;
    } else {
        // tau/rate: at 8x the car covers 8x the ground per wall-clock ms, so an
        // unscaled tau would grow the spatial lag 8x. Scaling keeps it constant.
        const rate = dom.player.paused ? 1 : Math.max(1, dom.player.playbackRate || 1);
        const dtScaled = frameDtMs * rate;
        const alphaCenter = 1 - Math.exp(-dtScaled / FOLLOW_CENTER_TAU_MS);
        followCamLat += (pos.lat - followCamLat) * alphaCenter;
        followCamLon += (targetLon - followCamLon) * alphaCenter;
        if (headingUp) {
            const alphaBearing = 1 - Math.exp(-dtScaled / FOLLOW_BEARING_TAU_MS);
            followCamBearing += wrapDegrees(pos.bearingDeg - followCamBearing) * alphaBearing;
        }
        if (zoomTarget !== undefined) {
            const alphaZoom = 1 - Math.exp(-dtScaled / FOLLOW_ZOOM_TAU_MS);
            followCamZoom += (zoomTarget - followCamZoom) * alphaZoom;
        }
    }

    const centerDone =
        Math.abs(pos.lat - followCamLat) < FOLLOW_SNAP_DEG && Math.abs(targetLon - followCamLon) < FOLLOW_SNAP_DEG;
    const bearingDone =
        !headingUp || Math.abs(wrapDegrees(pos.bearingDeg - followCamBearing)) < FOLLOW_SNAP_BEARING_DEG;
    const zoomDone = zoomTarget === undefined || Math.abs(zoomTarget - followCamZoom) < FOLLOW_SNAP_ZOOM;
    // A moving center must not keep a settled zoom invalidating the map style.
    if (zoomDone && zoomTarget !== undefined) followCamZoom = zoomTarget;
    if (centerDone && bearingDone && zoomDone) {
        followCamLat = pos.lat;
        followCamLon = targetLon;
        followCamBearing += wrapDegrees(pos.bearingDeg - followCamBearing);
        followFilterConverged = true;
    }

    const jump: maplibregl.JumpToOptions = { center: [followCamLon, followCamLat] };
    // Wrap the unwrapped filter bearing back into MapLibre's range; without
    // heading-up the map bearing is left alone (north-up "follow" resets it in
    // applyFollowMode, "off" never reaches here).
    if (headingUp) jump.bearing = wrapDegrees(followCamBearing);
    if (zoomTarget !== undefined) jump.zoom = followCamZoom;
    map.jumpTo(jump);
}

// Soft-suspend the per-frame follow camera for the span of a one-off easeTo
// (recenter button, follow-mode switch, chase entry). Without this guard the
// per-frame jumpTo would land at the next rAF and cancel the one-off animation
// mid-flight (jumpTo stops any in-flight ease). The suspension covers the
// one-off's duration plus a small buffer; the filter is invalidated so the
// follow glide then resumes from wherever the ease left the camera.
let followEaseSuspendedUntilMs = 0;
function suspendFollowEase(durationMs: number): void {
    followEaseSuspendedUntilMs = performance.now() + durationMs + 50;
    resetFollowCameraFilter();
}

// --- transient post-interaction follow pause ------------------------------
//
// A real pan/zoom/rotate/pitch gesture hands the camera to the user: auto-follow
// is PAUSED, not switched off (the mode button stays lit). followResumeRemainingMs
// is how much grace time is left before the follow camera re-engages; refreshed to
// the full delay on every interaction so it counts from the LAST touch. It is
// drained ONLY while the video plays (see the marker loop) - a user who paused to
// inspect the map keeps the camera until they resume playback. On expiry the loop
// runs one smooth re-aim back to the car (resumeFollowAfterInteraction).
const FOLLOW_RESUME_DELAY_MS = 5000;
let followResumeRemainingMs = 0;
let followGraceLastTickMs = 0;
let followWasUserPaused = false;
function noteUserMapInteraction(): void {
    followResumeRemainingMs = FOLLOW_RESUME_DELAY_MS;
}

let markerLoopOnAfterTick: (() => void) | undefined;

/**
 * Restarts the rAF loop if it was stopped by the early-exit in tick. Safe to
 * call repeatedly - no-op if the loop is already running. Called from sites
 * where state.active may become non-null: after ingest, on playFrame, on expandMap.
 */
export function ensureMarkerLoop(): void {
    if (markerRafHandle !== null) return;
    if (markerTimerHandle !== null) {
        clearTimeout(markerTimerHandle);
        markerTimerHandle = null;
    }
    if (!state.active) return;
    startMarkerLoop({ onAfterTick: markerLoopOnAfterTick });
}

export function startMarkerLoop(opts: { onAfterTick?: () => void } = {}): void {
    if (opts.onAfterTick) markerLoopOnAfterTick = opts.onAfterTick;
    if (markerRafHandle !== null || markerTimerHandle !== null) return;
    let markerFrame: PlayerFrameObservation | null = null;
    let pendingFrameDtMs = 0;

    // Marker/camera work for one frame. Separate from the rAF tick so its
    // early-returns (no trip / no frame / GPS window ended) skip ONLY the map
    // work - onAfterTick in the rAF tick below must still run.
    const markerTick = (now: number, frameDtMs: number): boolean => {
        if (!state.active || !state.marker) return false;
        const mainMapVisible = state.hasTrack && state.mapExpanded && getViewPanels().map && !state.exportModeOpen;
        const miniMapVisible = state.hasTrack && !state.mapExpanded && !dom.miniMap.hidden;
        if (!mainMapVisible && !miniMapVisible) return false;
        const trip = state.trips[state.active.trip];
        if (!trip || trip.records.length === 0) return false;
        // The marker always reflects the actual currentTime of the video.
        // chartHoverX is only for the chart cursor (cursorPlugin) - graph hover
        // must not move the marker, otherwise the user loses track of where the
        // car actually is during playback.
        const frame = trip.frames[state.active.frame];
        if (!frame) return false;
        const targetUnix = currentRealUtc(frame);
        const pos = mapPositionAt(trip.records, targetUnix);
        syncGpsStatus(pos !== null);
        if (!pos) {
            // GPS window ended before video (Vantrue drops GPS on long stops;
            // GoPro cuts the gpmd track in the last second). Hide both markers
            // so they don't freeze at the last known point. Player metrics are
            // hidden in sync via the timeupdate handler.
            return false;
        }

        let cameraSettling = false;

        if (mainMapVisible) {
            const map = state.map;
            // The user is steering the camera: a live drag/rotate/pitch
            // (activeMapGestures) or the post-interaction grace window
            // (followResumeRemainingMs, drained by the loop only while playing).
            // Auto-follow is paused, not switched off - the mode button stays lit.
            const userPausing = activeMapGestures.size > 0 || followResumeRemainingMs > 0;
            // Resume latch: tracks ONLY the grace window, which is armed
            // exclusively by genuine user input (originalEvent-guarded). It must
            // NOT track activeMapGestures: a programmatic one-off ease with a
            // bearing change fires its own rotatestart/rotateend pair, and a
            // latch on the gesture set would read that as "user let go" and fire
            // resumeFollowAfterInteraction - whose own enterChaseCamera ease
            // starts the next rotatestart, an infinite ~550 ms ease loop that
            // keeps the map rendering forever (also through pauses).
            if (
                followWasUserPaused &&
                followResumeRemainingMs === 0 &&
                activeMapGestures.size === 0 &&
                state.followMode !== "off"
            ) {
                // Grace window just expired: glide once back to the car (chase
                // re-enters its 3D view), then per-frame follow resumes below.
                resumeFollowAfterInteraction();
            }
            followWasUserPaused = followResumeRemainingMs > 0;
            // Also skip the follow camera while a one-off easeTo (recenter /
            // follow-switch / the resume re-aim above) is mid-flight - a jumpTo
            // would cancel that animation on the next frame.
            const suspended = userPausing || now < followEaseSuspendedUntilMs;
            const following = !!map && !suspended && state.followMode !== "off";
            const headingUp = isHeadingUpMode(state.followMode);

            // Chase speed-adaptive zoom target (EMA-smoothed so it does not pump on
            // noisy GPS speed). Computed before the change check below so a still-
            // settling zoom counts as a change. The live chase zoom range stays
            // >= maxzoom 14, so this never refetches tiles (overzoom from cached).
            let zoomTarget: number | undefined;
            if (following && state.followMode === "chase" && chaseAdaptiveZoom) {
                if (dom.player.paused) {
                    // A pause freezes pos.speedMs - smoothing toward a frozen
                    // value only delays idle by seconds. Snap at once; the zoom
                    // FILTER still glides to the new target, so nothing jumps.
                    chaseSmoothedSpeedMs = pos.speedMs;
                } else {
                    // dt-aware EMA: the smoothing window stays ~constant in
                    // wall-clock regardless of rAF jitter.
                    const alpha = 1 - Math.exp(-frameDtMs / CHASE_SPEED_TAU_MS);
                    chaseSmoothedSpeedMs += (pos.speedMs - chaseSmoothedSpeedMs) * alpha;
                    // Snap once visually converged. The exponential approach
                    // never reaches float equality on its own, and the raw
                    // zoomTarget feeds the EXACT compare in targetChanged below
                    // - without the snap a stopped car keeps producing ULP-level
                    // zoom changes, re-arming the whole camera lane (jumpTo +
                    // repaint at 60 Hz) for ~20 s. 0.01 m/s maps to a zoom delta
                    // far below FOLLOW_SNAP_ZOOM, so the snap is invisible.
                    if (Math.abs(chaseSmoothedSpeedMs - pos.speedMs) < CHASE_SPEED_SNAP_MPS) {
                        chaseSmoothedSpeedMs = pos.speedMs;
                    }
                }
                zoomTarget = chaseZoomForSpeed(chaseSmoothedSpeedMs);
            }

            // Raw-target change detection: paused playback / a stopped car yield a
            // byte-identical pos, so marker + trail writes are skipped entirely.
            const targetChanged =
                pos.lat !== bigMapAppliedLat ||
                pos.lon !== bigMapAppliedLon ||
                pos.bearingDeg !== bigMapAppliedBearing ||
                (zoomTarget !== undefined && zoomTarget !== bigMapAppliedZoom);
            if (targetChanged) {
                // Trail overlay: dim the un-driven part of the track (a 4-stop
                // line-gradient rewrite on one layer, self-throttled). Inside the
                // change gate: a static playhead does not advance the driven part.
                setTrailProgress(computeTrackProgress(targetUnix));
                // The marker tracks the RAW position (the filter below is camera-
                // only): it must stay glued to the GPS truth, and Marker.setLngLat
                // is a pure DOM transform - no repaint to save.
                state.marker.setLngLat([pos.lon, pos.lat]);
                // rotationAlignment:"map" - bearing is in map coordinates (true
                // north). MapLibre counter-rotates the marker on map rotation, so
                // pos.bearingDeg always points the correct geographic direction.
                rotateMarker(state.marker, pos.bearingDeg);
                bigMapAppliedLat = pos.lat;
                bigMapAppliedLon = pos.lon;
                bigMapAppliedBearing = pos.bearingDeg;
                if (zoomTarget !== undefined) bigMapAppliedZoom = zoomTarget;
                followFilterConverged = false;
            }
            // Camera: keep stepping after the target stops changing until the
            // filter has settled onto it (convergence flips the flag and the
            // map goes idle - jumpTo on an identical transform is NOT free, it
            // fires move events and forces a repaint).
            if (map && following && !followFilterConverged) {
                stepFollowCamera(map, pos, zoomTarget, headingUp, frameDtMs);
                cameraSettling = !followFilterConverged;
            }
        }

        // Mini-map: the whole block is gated on a raw position change - a static
        // playhead touches neither the marker DOM (Marker._update allocates a
        // rAF promise per call even for an identical position) nor the camera.
        if (miniMapVisible && state.miniMap && state.miniMapMarker) {
            const miniChanged =
                pos.lat !== miniAppliedLat || pos.lon !== miniAppliedLon || pos.bearingDeg !== miniAppliedBearing;
            if (miniChanged) {
                miniAppliedLat = pos.lat;
                miniAppliedLon = pos.lon;
                miniAppliedBearing = pos.bearingDeg;
                const miniMap = state.miniMap;
                // Marker position + rotation: pure DOM (no repaint), applied on
                // every change so the arrow slides smoothly even between the
                // px-gated camera jumps below.
                state.miniMapMarker.setLngLat([pos.lon, pos.lat]);
                rotateMarker(state.miniMapMarker, pos.bearingDeg);

                // jumpTo - WebGL repaint, gate it. At zoom ~15, 1 px = ~10 m.
                // Threshold 3 px batches several frames into one camera update;
                // the marker still slides smoothly relative to the (briefly
                // stale) basemap.
                const newZoom = miniMapZoomForLat(pos.lat);
                const curZoom = miniMap.getZoom();
                const center = miniMap.getCenter();
                const lon = unwrapLongitude(pos.lon, center.lng);
                const curPx = miniMap.project(center);
                const newPx = miniMap.project([lon, pos.lat]);
                const pxDist = Math.hypot(curPx.x - newPx.x, curPx.y - newPx.y);
                const zoomChanged = Math.abs(newZoom - curZoom) > 0.001;
                if (pxDist >= MINI_MAP_REPAINT_THRESHOLD_PX || zoomChanged) {
                    miniMap.jumpTo({ center: [lon, pos.lat], zoom: newZoom });
                }
            }
        }
        return !dom.player.paused || cameraSettling;
    };

    const scheduleTick = (isAnimating: boolean): void => {
        // rAF also preserves the browser's background-tab suspension.
        if (isAnimating || document.hidden) markerRafHandle = requestAnimationFrame(tick);
        else markerTimerHandle = setTimeout(tick, DRIFT_SYNC_INTERVAL_MS);
    };

    const tick = (): void => {
        markerRafHandle = null;
        markerTimerHandle = null;
        // Early exit ONLY when no trip is active (idle before first trip
        // selection) - do not reschedule; ensureMarkerLoop() restarts when
        // state.active appears. Eliminates 60 Hz idle wake-ups.
        //
        // Deliberately NOT gated on state.marker: a no-GPS trip never creates
        // one (refreshMap bails before marker creation), and the old
        // `!state.marker` exit killed the whole loop - including onAfterTick
        // (driftSyncSlaves), the ONLY continuous master/slave resync during
        // steady multichannel playback. The marker-specific work skips itself
        // inside markerTick instead.
        if (!state.active) {
            markerRafHandle = null;
            return;
        }
        // During export the main thread handles worker ack messages from the
        // proxy sink (see writable-bridge.ts). Any rAF work here steals main-
        // thread time from those acks, stalling the worker in await.
        if (state.transcodeInProgress || document.hidden) {
            markerFrame = null;
            pendingFrameDtMs = 0;
            lastFrameMs = performance.now();
            scheduleTick(false);
            return;
        }
        const now = performance.now();
        // Clamp the frame delta: after a background-tab span rAF resumes with a
        // huge gap, and an unclamped dt would make the filter alphas ~1 (hard
        // snap). 100 ms keeps the glide graceful across dropped frames.
        const frameDtMs = Math.min(100, Math.max(1, now - lastFrameMs));
        lastFrameMs = now;
        pendingFrameDtMs += frameDtMs;
        // Slow lane: drift sync + grace-window countdown at a fixed cadence.
        if (now - slowLaneLastMs >= DRIFT_SYNC_INTERVAL_MS) {
            slowLaneLastMs = now;
            // Drain the post-interaction follow grace window, but ONLY while the
            // video is playing and the user is not mid-gesture - a paused
            // inspection should not let follow snap back. followGraceLastTickMs
            // is updated every slow tick (even when frozen) so a paused span is
            // never counted on resume.
            if (followResumeRemainingMs > 0 && !dom.player.paused && activeMapGestures.size === 0) {
                followResumeRemainingMs = Math.max(0, followResumeRemainingMs - (now - followGraceLastTickMs));
            }
            followGraceLastTickMs = now;
            // Player hook for master/slave drift sync in multi-channel trips.
            // No-op on single-channel. Runs even when markerTick skips its map
            // work (no GPS / GPS window ended) - drift sync needs no marker.
            markerLoopOnAfterTick?.();
        }
        const frame = followVideoFrame(now);
        if (frame && frame === markerFrame) {
            scheduleTick(true);
            return;
        }
        markerFrame = frame;
        const isAnimating = markerTick(now, pendingFrameDtMs);
        pendingFrameDtMs = 0;
        // Publish only after camera and marker writes, so a native render that
        // precedes this tick cannot consume a not-yet-applied video frame.
        followAppliedFrame = frame;
        followAppliedVideo = dom.player;
        followRenderCadence?.refresh();
        scheduleTick(isAnimating);
    };
    lastFrameMs = performance.now();
    markerRafHandle = requestAnimationFrame(tick);
}

// Minimum pixel shift before a mini-map repaint. At zoom ~15, 1 px = ~10 m, so
// the camera re-centers every ~3 px of car travel - a 3 px jump in a small
// thumbnail is imperceptible as jitter, and the marker slides smoothly on top.
const MINI_MAP_REPAINT_THRESHOLD_PX = 3;

// =====================================================================
// Chase camera (followMode "chase")
// =====================================================================
// "chase" = heading-up follow (like "rotate") + camera tilt + 3D buildings,
// optionally with speed-adaptive zoom. The "dashcam / racing-game" view.
//
// Performance notes (this map repaints continuously during playback, so every
// added per-frame cost matters):
//  - Tilt is a one-off setPitch on enter + the slider; the hot follow loop does
//    NOT touch pitch (it is sticky in MapLibre, and jumpTo without a pitch key
//    leaves it alone), so chase costs the same per-frame camera step as
//    "rotate".
//  - 3D buildings (fill-extrusion) are added ONLY while chase is active and
//    removed on exit, so flat/overview/north-up views pay nothing. minzoom 14
//    means they render only at street zoom, never on the trip-overview fit.
//  - Adaptive zoom rides on the SAME per-frame camera step (just adds a zoom
//    target), and the whole zoom range stays >= the vector source maxzoom (14),
//    so changing it overzooms from the already-cached z14 tiles - no extra tile
//    fetches.

// Slider ceiling. See the maxPitch comment in ensureMap for why 70, not 85.
const CHASE_MAX_PITCH_DEG = MAX_MAP_PITCH_DEG;
const CHASE_DEFAULT_PITCH_DEG = 58;
// Street-level zoom chase eases to on entry when the user was zoomed out on the
// trip overview. Buildings live at z14+, so a tilted overview would show none.
const CHASE_DEFAULT_ZOOM = 16.4;
// Speed-adaptive zoom: zoom out as speed rises so the road ahead stays in view.
// Range is narrow AND entirely above the source maxzoom (14) on purpose - every
// value overzooms from the same z14 vector tiles, so sweeping it fetches no new
// tiles (verified against the OpenFreeMap planet TileJSON: maxzoom 14).
const CHASE_ZOOM_AT_REST = 16.8;
const CHASE_ZOOM_AT_SPEED = 15.4;
const CHASE_SPEED_FULL_MS = 33; // ~120 km/h -> most zoomed-out end
// Time constant for the EMA that smooths the speed feeding adaptive zoom (so the
// zoom does not pump at every light or noisy fix). The per-frame factor is
// derived from the actual frame delta (alpha = 1 - exp(-dt/tau)), NOT a fixed
// constant, so the smoothing window stays ~0.7 s wall-clock regardless of rAF
// jitter.
const CHASE_SPEED_TAU_MS = 700;
// EMA convergence snap, in m/s - see the snap comment in markerTick.
const CHASE_SPEED_SNAP_MPS = 0.01;
const BUILDINGS_3D_LAYER_ID = "dc-buildings-3d";
// Both styles (light/dark) share this OpenFreeMap vector source id and the
// "building" source-layer (verified in public/styles/*.json).
const VECTOR_SOURCE_ID = "openmaptiles";
const BUILDING_SOURCE_LAYER = "building";

const CHASE_PITCH_STORAGE_KEY = "everydashcam:chase-pitch";
const CHASE_ADAPTIVE_STORAGE_KEY = "everydashcam:chase-adaptive-zoom";

// User-tunable chase state, hydrated from localStorage in initMap. Kept module-
// level so the follow loop and the controls share one source of truth.
let chasePitchDeg = CHASE_DEFAULT_PITCH_DEG;
let chaseAdaptiveZoom = true;
// EMA-smoothed speed (m/s) for adaptive zoom. Reset on chase enter so the first
// frame does not lurch from a stale value.
let chaseSmoothedSpeedMs = 0;

function clampPitch(deg: number): number {
    if (!Number.isFinite(deg)) return CHASE_DEFAULT_PITCH_DEG;
    return Math.max(0, Math.min(CHASE_MAX_PITCH_DEG, deg));
}

/** True for the heading-up follow modes (camera bearing tracks the car). Drives
 *  the per-frame bearing write and recenter bearing. */
function isHeadingUpMode(mode: FollowMode): boolean {
    return mode === "rotate" || mode === "chase";
}

function syncProviderCamera(): void {
    const camera = MAP_PROVIDER_REGISTRY[getMapProvider()].camera;
    const map = state.map;
    if (map) {
        // Also constrain an animation or compass drag already active at fallback.
        map.setTransformCameraUpdate(
            camera.supportsHeadingUp ? null : (next) => camera.orient(next.bearing, next.pitch),
        );
        if (!camera.supportsHeadingUp) {
            map.stop();
            map.setMaxPitch(camera.maxPitch);
            map.dragRotate.disable();
            map.touchZoomRotate.disableRotation();
            map.keyboard.disableRotation();
            map.jumpTo(camera.orient(map.getBearing(), map.getPitch()));
            removeBuildings3dLayer(map);
        } else {
            map.setMaxPitch(camera.maxPitch);
            map.dragRotate.enable();
            map.touchZoomRotate.enableRotation();
            map.keyboard.enableRotation();
        }
    }
    if (!camera.supportsHeadingUp && isHeadingUpMode(state.followMode)) applyFollowMode("follow");
    else syncMapFollowButton();
    syncBigMapPixelRatio();
}

/** Maps speed to a chase zoom: rest -> zoomed in, fast -> zoomed out. Monotonic,
 *  clamped to [CHASE_ZOOM_AT_SPEED, CHASE_ZOOM_AT_REST] (both above maxzoom 14). */
function chaseZoomForSpeed(speedMs: number): number {
    const f = Math.max(0, Math.min(1, speedMs / CHASE_SPEED_FULL_MS));
    return CHASE_ZOOM_AT_REST + (CHASE_ZOOM_AT_SPEED - CHASE_ZOOM_AT_REST) * f;
}

function loadChasePitch(): number {
    const raw = readLocalStorage(CHASE_PITCH_STORAGE_KEY);
    return raw === null ? CHASE_DEFAULT_PITCH_DEG : clampPitch(Number(raw));
}

function persistChasePitch(deg: number): void {
    writeLocalStorage(CHASE_PITCH_STORAGE_KEY, String(Math.round(deg)));
}

function loadChaseAdaptiveZoom(): boolean {
    // Default ON: absent key -> true. Only an explicit "0" disables it.
    return readLocalStorage(CHASE_ADAPTIVE_STORAGE_KEY) !== "0";
}

function persistChaseAdaptiveZoom(on: boolean): void {
    writeLocalStorage(CHASE_ADAPTIVE_STORAGE_KEY, on ? "1" : "0");
}

/** First symbol layer id, so the 3D building extrusion is inserted UNDER the
 *  labels (street names / POIs stay readable on top of the buildings). */
function firstSymbolLayerId(map: maplibregl.Map): string | undefined {
    const layers = map.getStyle().layers ?? [];
    for (const l of layers) {
        if (l.type === "symbol") return l.id;
    }
    return undefined;
}

/**
 * Adds the 3D building extrusion layer if it is not already present and the map
 * carries an OpenFreeMap or Shortbread vector source. Idempotent. `theme` picks the wall
 * color (the export snapshotter passes its own base-layer theme, independent of
 * the app UI theme). Flat footprints remain visible underneath, including while
 * the extrusion fades in and when the user leaves the tilted view.
 *
 * Exported so the export-overlay snapshotter renders the exact same buildings as
 * the live chase map (one source of truth for the layer definition).
 */
export function addBuildings3dLayer(map: maplibregl.Map, theme: MapStyleId): void {
    if (map.getLayer(BUILDINGS_3D_LAYER_ID)) return;
    // Style may still be EMPTY_MAP_STYLE (tiles unavailable) or mid-swap - bail
    // silently; the live style.load handler re-adds it once chase is active.
    const hasOpenMapTiles = Boolean(map.getSource(VECTOR_SOURCE_ID));
    const hasShortbread = Boolean(map.getSource(OSM_SHORTBREAD_SOURCE_ID));
    if (!hasOpenMapTiles && !hasShortbread) return;
    const source = hasOpenMapTiles ? VECTOR_SOURCE_ID : OSM_SHORTBREAD_SOURCE_ID;
    const sourceLayer = hasOpenMapTiles ? BUILDING_SOURCE_LAYER : OSM_SHORTBREAD_BUILDING_SOURCE_LAYER;
    // Neon: lit amber walls so buildings glow with the rest of the slot. Dark:
    // near-black. Light: bone.
    const walls = theme === "neon" ? "#7a4a16" : theme === "dark" ? "#2b2b30" : "#e4ddcd";
    map.addLayer(
        {
            id: BUILDINGS_3D_LAYER_ID,
            type: "fill-extrusion",
            source,
            "source-layer": sourceLayer,
            minzoom: 14,
            // OMT outlines accompany building parts and must not become solid blocks.
            ...(hasOpenMapTiles ? { filter: ["!=", ["get", "hide_3d"], true] as maplibregl.FilterSpecification } : {}),
            paint: {
                "fill-extrusion-color": walls,
                // OpenMapTiles carries render_height/render_min_height; fall back
                // to height/min_height, then a 5 m default so footprints without
                // a height still read as low buildings rather than vanishing.
                // Shortbread 1.0 exposes footprints but no height fields. Keep
                // chase depth with a conservative 5 m extrusion; OpenMapTiles
                // retains its data-driven heights.
                "fill-extrusion-height": hasOpenMapTiles
                    ? ["coalesce", ["get", "render_height"], ["get", "height"], 5]
                    : 5,
                "fill-extrusion-base": hasOpenMapTiles
                    ? ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0]
                    : 0,
                // Fade in across z14->15.5 so buildings do not pop at the minzoom
                // edge while the user is zooming into chase.
                "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, 0.92],
            } as never,
        },
        firstSymbolLayerId(map),
    );
}

/** Removes the 3D building extrusion. Idempotent. Exported alongside
 *  addBuildings3dLayer so the export preview can drop it when switching back to
 *  north-up (else the flat extrusion footprints linger on a top-down view). */
export function removeBuildings3dLayer(map: maplibregl.Map): void {
    if (map.getLayer(BUILDINGS_3D_LAYER_ID)) map.removeLayer(BUILDINGS_3D_LAYER_ID);
}

/** Live-map wrapper: buildings track the current app map theme. (Removal needs
 *  no theme, so leaveChaseCamera calls removeBuildings3dLayer directly.) */
function ensure3dBuildings(map: maplibregl.Map): void {
    if (getMapViewPreferences().buildings3d) addBuildings3dLayer(map, currentMapTheme());
    else removeBuildings3dLayer(map);
}

/**
 * Enters the chase camera: adds 3D buildings and eases to a tilted, heading-up,
 * street-level view. `pos` is the current interpolated car position (may be null
 * if the playhead is outside the GPS window - we still tilt, just without a
 * center/bearing target). Zoom on entry is the speed-adaptive target (if on) or
 * the user's current zoom bumped up to at least street level.
 */
function enterChaseCamera(
    map: maplibregl.Map,
    pos: { lat: number; lon: number; bearingDeg: number; speedMs: number } | null,
): void {
    ensure3dBuildings(map);
    chaseSmoothedSpeedMs = pos?.speedMs ?? 0;
    const duration = 500;
    const opts: maplibregl.EaseToOptions = { pitch: chasePitchDeg, duration };
    if (pos) {
        opts.center = [pos.lon, pos.lat];
        opts.bearing = pos.bearingDeg;
        opts.zoom = chaseAdaptiveZoom ? chaseZoomForSpeed(pos.speedMs) : Math.max(map.getZoom(), CHASE_DEFAULT_ZOOM);
    }
    suspendFollowEase(duration);
    map.easeTo(opts);
}

/**
 * Leaves the chase camera: removes 3D buildings and eases the tilt back to flat.
 * Bearing/center are handled by the caller's mode-switch ease (or left as-is for
 * the "off" target, which does not recenter).
 */
function leaveChaseCamera(map: maplibregl.Map): void {
    removeBuildings3dLayer(map);
}

/**
 * One smooth re-aim back to the car after the post-interaction grace window
 * expired. Chase re-enters fully (re-tilt + re-aim + adaptive zoom + buildings),
 * so a drag/zoom that flattened or zoomed the view glides back into the 3D chase.
 * follow/rotate ease to the car, flatten any user tilt, and (follow) undo a user
 * rotation back to north-up. Called only from the marker loop, with followMode
 * guaranteed non-"off"; the follow camera stays suspended for the transition via
 * suspendFollowEase (inside enterChaseCamera / here).
 */
function resumeFollowAfterInteraction(): void {
    const map = state.map;
    if (!map) return;
    const pos = currentInterpolatedPosition();
    if (state.followMode === "chase") {
        enterChaseCamera(map, pos);
        return;
    }
    if (!pos) return;
    const duration = 500;
    const opts: maplibregl.EaseToOptions = { center: [pos.lon, pos.lat], duration };
    // rotate is heading-up; follow is north-up, so undo a rotation done during the pause.
    if (isHeadingUpMode(state.followMode)) opts.bearing = pos.bearingDeg;
    else if (Math.abs(map.getBearing()) > 0.5) opts.bearing = 0;
    // Non-chase is flat: undo a two-finger tilt the user may have applied.
    if (map.getPitch() > 1) opts.pitch = 0;
    suspendFollowEase(duration);
    map.easeTo(opts);
}

/**
 * The follow loop does not drive pitch. Complete the configured tilt after
 * initial display or a style swap that interrupted the entry animation.
 */
function ensureChaseEngaged(): void {
    const map = state.map;
    if (
        !map ||
        !state.mapReady ||
        !state.mapExpanded ||
        !state.hasTrack ||
        !getViewPanels().map ||
        state.exportModeOpen ||
        state.followMode !== "chase"
    )
        return;
    if (Math.abs(map.getPitch() - chasePitchDeg) < 0.1) {
        ensure3dBuildings(map);
        return;
    }
    enterChaseCamera(map, currentInterpolatedPosition());
}

/** Syncs the chase sub-controls (tilt slider + adaptive-zoom toggle) visibility
 *  and values to the current mode/state. Called from syncMapFollowButton. */
function syncChaseControls(): void {
    if (dom.mapChaseControls) dom.mapChaseControls.hidden = state.followMode !== "chase";
    if (dom.mapChaseAdaptive) {
        dom.mapChaseAdaptive.setAttribute("aria-pressed", chaseAdaptiveZoom ? "true" : "false");
        dom.mapChaseAdaptive.classList.toggle("active", chaseAdaptiveZoom);
    }
}

/**
 * Attaches all map-related event listeners (follow toggle, recenter,
 * expand/collapse, mini-map, style error retry/dismiss, theme change, drag).
 * Call once at startup after ensureMap/ensureMiniMap.
 */
export function initMap(cb: MapCallbacks): void {
    callbacks = cb;
    onActivePlayerEvent("play", () => {
        syncBigMapPixelRatio();
        ensureMarkerLoop();
    });
    onActivePlayerEvent("pause", syncBigMapPixelRatio);
    onActivePlayerEvent("ended", syncBigMapPixelRatio);
    onActivePlayerEvent("emptied", syncBigMapPixelRatio);
    onActivePlayerEvent("seeking", ensureMarkerLoop);
    onActivePlayerEvent("seeked", ensureMarkerLoop);
    state.mapExpanded = getPreferredMapMode() === "large";
    subscribeMapMarkerAppearance(refreshLiveMapMarkerAppearance);
    let mapPreferences = getMapViewPreferences();
    subscribeMapViewPreferences((next) => {
        const needsStyle = next.style !== mapPreferences.style || next.theme !== mapPreferences.theme;
        mapPreferences = next;
        if (needsStyle) reloadMapStyleForCurrentTheme();
        else if (state.map && state.mapReady && (state.followMode === "chase" || state.map.getPitch() > 1))
            ensure3dBuildings(state.map);
        else if (state.map && state.mapReady && !next.buildings3d) removeBuildings3dLayer(state.map);
    });
    let wasOffline = isOffline();
    subscribeConnectivity((offline) => {
        if (offline) scheduleMapRecovery();
        else {
            if (mapRecoveryTimer !== null) clearTimeout(mapRecoveryTimer);
            mapRecoveryTimer = null;
            if (wasOffline) {
                // Let the successful shared fetch enter its cache before a
                // style swap aborts the old map's remaining tile consumers.
                mapRecoveryTimer = setTimeout(() => {
                    mapRecoveryTimer = null;
                    if (needsMapRecovery()) scheduleMapRecovery();
                    else retryMapResources();
                }, 0);
            }
        }
        wasOffline = offline;
    });
    window.addEventListener("online", () => {
        // The navigator flag may clear while a tile failure still holds the
        // combined offline state, so this cannot rely on a state transition.
        if (needsMapRecovery()) retryMapResources();
    });

    subscribeMapProvider((provider, previous) => {
        if (previous === null) return;
        // Automatic local fallback keeps probing; an explicit local choice
        // stops recovery even if failed tiles still mark connectivity offline.
        if (provider === "route-only") {
            if (mapRecoveryTimer !== null) clearTimeout(mapRecoveryTimer);
            mapRecoveryTimer = null;
        }
        scheduleMapRecovery();
        syncProviderCamera();
        const theme = currentMapTheme();
        loadMapStyle(theme, false, "main", provider).then((style) => {
            if (style) applyLoadedStyle(style, theme, provider, true);
        });
    });

    // UX-18: 3-button segmented control with a delegated listener on the container.
    // Each button directly selects a mode (no cycle), making all options visible.
    dom.mapFollowSegments.addEventListener("click", (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest<HTMLButtonElement>(".map-follow-seg");
        if (!btn) return;
        const mode = btn.dataset.followMode as FollowMode | undefined;
        if (!mode) return;
        applyFollowMode(mode);
    });

    // Recenter button: snaps the camera to the current car position and clears any
    // pending post-interaction pause, so an active follow mode resumes immediately
    // instead of waiting out the grace window. In "off" mode it just centers.
    dom.mapRecenterBtn.addEventListener("click", () => {
        if (!state.map) return;
        const pos = currentInterpolatedPosition();
        if (!pos) return;
        // Clear the pause + its resume latch so an active follow mode re-engages
        // now instead of waiting out the grace window (and without a double re-aim).
        resetFollowInteractionPause();
        const duration = 400;
        // Adjust bearing only in heading-up modes (rotate/chase); preserve the
        // user's orientation otherwise. Pitch is sticky, so a chase recenter
        // keeps its tilt without setting it here.
        const easeOptions: maplibregl.EaseToOptions = { center: [pos.lon, pos.lat], duration };
        if (isHeadingUpMode(state.followMode)) {
            easeOptions.bearing = pos.bearingDeg;
        }
        suspendFollowEase(duration);
        state.map.easeTo(easeOptions);
    });

    // Chase camera sub-controls. Hydrate persisted prefs once, then wire the
    // tilt slider and the speed-adaptive-zoom toggle. Both only matter in chase
    // mode; the container is hidden otherwise via syncChaseControls.
    chasePitchDeg = loadChasePitch();
    chaseAdaptiveZoom = loadChaseAdaptiveZoom();
    dom.mapChaseTilt.max = String(CHASE_MAX_PITCH_DEG);
    dom.mapChaseTilt.value = String(chasePitchDeg);
    dom.mapChaseTilt.addEventListener("input", () => {
        chasePitchDeg = clampPitch(Number(dom.mapChaseTilt.value));
        persistChasePitch(chasePitchDeg);
        // setPitch is instant (no animation): the right feel while dragging and
        // cheaper than a per-input easeTo. Only act while chase is live.
        if (state.map && state.followMode === "chase") state.map.setPitch(chasePitchDeg);
    });
    dom.mapChaseAdaptive.addEventListener("click", () => {
        chaseAdaptiveZoom = !chaseAdaptiveZoom;
        persistChaseAdaptiveZoom(chaseAdaptiveZoom);
        syncChaseControls();
        // Turning it ON while chasing: seed the smoothed speed from the current
        // car so the next tick eases zoom to the speed target instead of lurching
        // from a stale value. Turning it OFF leaves zoom where it is (user owns it).
        if (chaseAdaptiveZoom && state.followMode === "chase") {
            const pos = currentInterpolatedPosition();
            if (pos) chaseSmoothedSpeedMs = pos.speedMs;
        }
    });
    // Reflect the hydrated toggle state (aria-pressed/active) on first paint.
    syncChaseControls();

    dom.mapCollapseBtn.addEventListener("click", () => collapseMap(dom.viewMenuButton));
    // Player-bar map toggle: single entry point for mobile users to expand or
    // collapse the map (mini-map is hidden via CSS on mobile). Force
    // userWantsMap=true on expand so the click works regardless of the View
    // menu state - on mobile that menu is buried inside the overflow kebab
    // and users would otherwise hit a no-op button on the first tap. Collapse
    // does NOT flip userWantsMap off: a user who explicitly enabled the map
    // panel may want it shown as the mini-map on desktop later.
    dom.playerMapBtn.addEventListener("click", () => {
        if (state.mapExpanded) {
            collapseMap(dom.playerMapBtn);
        } else {
            expandMap(dom.playerMapBtn);
        }
    });
    setMapModeRequestHandler((mode) => setMapViewMode(mode, dom.viewMenuButton));
    // Close-X on the mini-map: morph into "View" button + flip menu state.
    dom.miniMapClose.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMiniMapToViewMenu();
    });
    // Re-apply map layout when map visibility changes outside the tri-state
    // handler (trip availability, compatibility and export lifecycle paths).
    subscribeViewPanels(() => applyMapLayout());
    // Entering/leaving export mode hides/restores the viewer's map + mini-map
    // (see applyMapLayout's exportSuppressed branch). Recompute on every
    // export-state change; cheap (a few class/hidden toggles + a gated resize).
    subscribeExportState(() => applyMapLayout());

    // Dismiss/Escape only hide the banner; retry also refreshes the style cache
    // shared with the export map.
    dom.mapStyleRetry.addEventListener("click", () => {
        dom.mapStyleRetry.disabled = true;
        const theme = lastFailedStyle?.theme ?? currentMapTheme();
        const provider = lastFailedStyle?.provider ?? getMapProvider();
        const source = lastFailedStyle?.source ?? "main";
        loadMapStyle(theme, true, source, provider)
            .then((style) => {
                if (style) applyLoadedStyle(style, theme, provider);
            })
            .finally(() => {
                dom.mapStyleRetry.disabled = false;
            });
    });

    dom.mapStyleDismiss.addEventListener("click", hideMapStyleError);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !dom.mapStyleError.hidden) {
            hideMapStyleError();
        }
    });

    initMiniMapDrag();
    initMiniMapHover();

    // Toggle cooperative gestures if the pointer type flips (a mouse attached to /
    // detached from a convertible, which switches coarse<->fine) or the layout
    // crosses the stacked-mode boundary (window resized across the mobile
    // media). The map is created lazily, so the handler no-ops until ensureMap
    // has run.
    window.matchMedia?.(COARSE_POINTER_QUERY).addEventListener("change", syncCooperativeGestures);
    window.matchMedia?.(MOBILE_LAYOUT_QUERY).addEventListener("change", syncCooperativeGestures);
}

function canResetMapBearing(map: maplibregl.Map): boolean {
    return state.followMode !== "chase" && map.getPitch() <= 1;
}

function guardMapCompass(map: maplibregl.Map): void {
    const compass = map.getContainer().querySelector<HTMLButtonElement>(".maplibregl-ctrl-compass");
    if (!compass) return;
    const preventUnavailableInteraction = (event: Event): void => {
        const canRotate = MAP_PROVIDER_REGISTRY[getMapProvider()].camera.supportsHeadingUp;
        if (canResetMapBearing(map) && (event.type === "click" || canRotate)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    // The compass rotates independently of dragRotate, even on disabled buttons.
    for (const event of ["click", "mousedown", "touchstart"]) {
        compass.addEventListener(event, preventUnavailableInteraction, { capture: true, passive: false });
    }
}

function syncMapCompassAvailability(shouldRefreshLabel = false): void {
    const map = state.map;
    if (!map) return;
    const compass = map.getContainer().querySelector<HTMLButtonElement>(".maplibregl-ctrl-compass");
    if (!compass) return;
    const isDisabled = !canResetMapBearing(map);
    const ariaDisabled = String(isDisabled);
    if (
        !shouldRefreshLabel &&
        compass.disabled === isDisabled &&
        compass.getAttribute("aria-disabled") === ariaDisabled
    )
        return;
    compass.disabled = isDisabled;
    compass.setAttribute("aria-disabled", ariaDisabled);
    const label = t(isDisabled ? "map.ctrl.resetBearingFlatOnly" : "map.ctrl.resetBearing");
    compass.setAttribute("title", label);
    compass.setAttribute("aria-label", label);
}

/**
 * MapLibre has no public setLocale API, so navigation labels are patched on
 * their public control elements without accessing the private locale state.
 */
function localizeMapNavControls(): void {
    if (!state.map) return;
    const container = state.map.getContainer();
    const setBtn = (selector: string, key: "map.ctrl.zoomIn" | "map.ctrl.zoomOut") => {
        const btn = container.querySelector<HTMLElement>(selector);
        if (!btn) return;
        const label = t(key);
        btn.setAttribute("title", label);
        btn.setAttribute("aria-label", label);
    };
    setBtn(".maplibregl-ctrl-zoom-in", "map.ctrl.zoomIn");
    setBtn(".maplibregl-ctrl-zoom-out", "map.ctrl.zoomOut");
    syncMapCompassAvailability(true);
}

/**
 * MapLibre locale patch for the cooperative-gestures overlay: the touch "two
 * fingers" message plus the wheel-bypass one. MapLibre picks Windows vs Mac by
 * platform sniff - the bypass key is Cmd on a Mac, Ctrl everywhere else - and
 * its own CSS decides which of the two baked messages is shown.
 */
function cooperativeLocale(): Record<string, string> {
    return {
        "CooperativeGesturesHandler.MobileHelpText": t("map.coop.twoFingers"),
        "CooperativeGesturesHandler.WindowsHelpText": t("map.coop.ctrlScroll"),
        "CooperativeGesturesHandler.MacHelpText": t("map.coop.cmdScroll"),
    };
}

/**
 * Enables cooperative gestures on touch and in the stacked layout (the page
 * must be scrollable past the map there), disables them in the wide desktop
 * split. Idempotent; no-op until the map exists. Called on pointer-type and
 * layout flips; the construction option sets the initial state.
 */
function syncCooperativeGestures(): void {
    const map = state.map;
    if (!map) return;
    const handler = map.cooperativeGestures;
    const want = isCoarsePointer() || isMobileLayout();
    if (want && !handler.isEnabled()) {
        handler.enable();
        // enable() rebuilds the overlay from map._locale, which still holds the
        // construction-time language - patch it to the current one.
        localizeCooperativeOverlay();
    } else if (!want && handler.isEnabled()) {
        handler.disable();
    }
}

/**
 * Patches the cooperative-gestures overlay text to the current language. The text
 * is baked into the DOM at enable() time, so a mid-session language switch needs
 * an explicit patch (same approach as localizeMapNavControls). No-op when the
 * overlay is absent (cooperative disabled, or the map not built yet).
 */
function localizeCooperativeOverlay(): void {
    if (!state.map) return;
    const screen = state.map.getContainer().querySelector<HTMLElement>(".maplibregl-cooperative-gesture-screen");
    if (!screen) return;
    const mobileMsg = screen.querySelector<HTMLElement>(".maplibregl-mobile-message");
    if (mobileMsg) mobileMsg.textContent = t("map.coop.twoFingers");
    // Same platform sniff MapLibre's handler uses for its bypass key: the
    // desktop message must name the key the handler actually honors.
    const desktopMsg = screen.querySelector<HTMLElement>(".maplibregl-desktop-message");
    if (desktopMsg) {
        desktopMsg.textContent = navigator.userAgent.includes("Mac")
            ? t("map.coop.cmdScroll")
            : t("map.coop.ctrlScroll");
    }
}

/**
 * Fetches and applies the map style for the current theme. Both themes are
 * prefetched in ensureMap, so this is usually a cache hit. applyLoadedStyle
 * verifies theme freshness before applying so a stale result from a double-
 * switch is discarded.
 */
export function reloadMapStyleForCurrentTheme(): void {
    // No map yet (user is on the landing page, initTripUi not called) - skip the
    // fetch; applyLoadedStyle would no-op anyway, but we also save the network request.
    if (!state.map) return;
    const theme = currentMapTheme();
    const provider = getMapProvider();
    loadMapStyle(theme, false, "main", provider).then((style) => {
        if (style) applyLoadedStyle(style, theme, provider, true);
    });
}

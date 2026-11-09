// Everything the viewer's MapLibre surfaces share: the lazily loaded library,
// the style cache and its failure state, style swaps on theme, provider and
// label changes, recovery after a network outage, and WebGL context loss. Each
// surface registers its map here and keeps only its own overlays and camera.

// Type-only import: erased at build, so it does NOT pull the ~1MB maplibre-gl
// lib into the bundle. The runtime namespace is loaded lazily via loadMaplibre().
// Namespace form: v6 is ESM-only and has no default export.
import type * as maplibregl from "maplibre-gl";
// Worker entry URL, resolved at build time to a string - the lib itself stays
// out of the eager graph. Keep `?worker&url` so Vite builds the worker and the
// portable plugin can embed its classic IIFE for file origins.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import { getCurrentLang } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { captureSentryMessage } from "../sentry.js";
import { createSubscribers } from "../subscribers.js";
import { isOffline, subscribeConnectivity } from "./connectivity.js";
import type { MapAttributionControl } from "./map-attribution-control.js";
import { applyViewerLabelPrefs } from "./map-label-scale.js";
import {
    getMapProvider,
    getMapProviderPreference,
    mapProviderErrorKey,
    reportMapProviderTileError,
    retryMapProvider,
    subscribeMapProvider,
    type MapProvider,
} from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { loadMapStyleSource } from "./map-style-source.js";
import { applyMapStylePreset } from "./map-style-preset.js";
import { registerSharedMapTileCache } from "./map-tile-cache.js";
import { getMapViewPreferences, subscribeMapViewPreferences } from "./map-view-pref.js";
import { createFallbackMapStyle } from "./osm-fallback-style.js";
import { createPortableMapAssetLoader } from "./portable-map-assets.js";
import { currentMapTheme, mapThemeColors } from "./theme.js";
import type { MapStyleId, MapTheme } from "./theme.js";
import { createYandexMapStyle } from "./yandex-map.js";

// Shares the trip map's logger name: browser tests recognize the
// "[map] maplibre [mini ]error" lines by it.
const log = createLogger("map");

// --- lazy maplibre-gl loading (T9) ---
//
// maplibre-gl is ~1MB. A static value-import put the lib in the landing entry
// chunk - Vite modulepreloaded it before any trip was opened, pure waste on the
// indexed home page (LCP/TBT hit). We load the runtime namespace once, on
// demand, and keep it in `mlg`. loadMaplibre() is awaited by initTripUi (before
// any map is created) and by export-map-snapshot. Invariant: nothing constructs
// a map/marker/popup before loadMaplibre() resolves, so loadedMaplibre() at the
// construction sites always holds (ensureMap/ensureMiniMap and every
// marker/popup helper run on the trip path, after init).
export type MaplibreNamespace = typeof import("maplibre-gl");
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

/** The namespace loadMaplibre() resolved; synchronous code on the trip path relies on that load. */
export function loadedMaplibre(): MaplibreNamespace {
    if (!mlg) throw new Error("maplibre-gl is not loaded");
    return mlg;
}

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

// Style cache: every map shares one URL per theme, no double fetch. The promise
// is cleared after failure so retry triggers a real re-request. Both themes are
// prefetched when a map registers (the inactive one with source="prefetch",
// silent on failure) so theme toggles and the export-overlay snapshotter (always
// "light") hit the cache instead of triggering a fresh fetch with its own
// failure surface.
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

/** A viewer map that follows the shared style. "main" is the trip's large map. */
export type ViewerMapSurface = "main" | "mini";

export interface ViewerMap {
    map: maplibregl.Map;
    surface: ViewerMapSurface;
    attribution: MapAttributionControl;
    /** Runs before every style swap; overlays come back on the map's style.load. */
    beforeStyleSwap?: (shouldPreserveCamera: boolean) => void;
    /** The context took the style with it: overlay writes must wait for style.load. */
    onContextLost?: () => void;
}

// Insertion order is the order style swaps reach the maps.
const viewerMaps = new Set<ViewerMap>();
// Registration loads started per style, so a second map registering while the
// first one's style is still on its way does not set the same style twice.
const registrationLoads = new Set<MapStyleCacheKey>();

/**
 * Puts a freshly constructed map under the shared style: the current style is
 * applied now when cached, otherwise when its shared load completes. Call after
 * the map's own style.load and styledataloading handlers are attached. The map
 * leaves the registry on remove or through the returned function.
 */
export function registerViewerMap(viewerMap: ViewerMap): () => void {
    installStyleSubscriptions();
    viewerMaps.add(viewerMap);
    observeViewerMap(viewerMap);
    const unregister = (): void => {
        viewerMaps.delete(viewerMap);
    };
    viewerMap.map.once("remove", unregister);

    const theme = currentMapTheme();
    const provider = getMapProvider();
    const key = styleCacheKey(provider, theme);
    const cached = cachedMapStyles.get(key);
    if (registrationLoads.has(key)) {
        // The pending load applies its style to every registered map.
    } else if (cached) {
        applyStyleTo(viewerMap, applyViewerMapStyle(cached), provider, false);
    } else {
        registrationLoads.add(key);
        void loadMapStyle(theme, false, "main", provider).then((style) => {
            registrationLoads.delete(key);
            if (style) applyLoadedStyle(style, theme, provider);
        });
    }
    // Warm the alternate palette for map settings and export; background
    // requests must not show a failure banner for an unselected style.
    const otherTheme: MapTheme = theme === "light" ? "dark" : "light";
    void loadMapStyle(otherTheme, false, "prefetch", provider);
    return unregister;
}

// A lost context cannot accept style changes. Retain only the latest choice.
const lostViewerMapStyles = new WeakMap<maplibregl.Map, maplibregl.StyleSpecification | null>();

function setViewerMapStyle(map: maplibregl.Map, style: maplibregl.StyleSpecification): void {
    if (lostViewerMapStyles.has(map)) lostViewerMapStyles.set(map, style);
    else map.setStyle(style, { diff: false });
}

function applyStyleTo(
    viewerMap: ViewerMap,
    styled: maplibregl.StyleSpecification,
    provider: MapProvider,
    shouldPreserveCamera: boolean,
): void {
    viewerMap.beforeStyleSwap?.(shouldPreserveCamera);
    setViewerMapStyle(viewerMap.map, styled);
    viewerMap.attribution.setProvider(provider);
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
    for (const viewerMap of viewerMaps) applyStyleTo(viewerMap, styled, provider, shouldPreserveCamera);
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

/** Overlay colors that read on the base map the viewer currently shows. */
export function viewerMapColors(): ReturnType<typeof mapThemeColors> {
    const provider = getMapProvider();
    return mapThemeColors(MAP_PROVIDER_REGISTRY[provider].usesSelectedTheme ? currentMapTheme() : "light");
}

/**
 * Fetches and applies the map style for the current theme. Both themes are
 * prefetched when a map registers, so this is usually a cache hit.
 * applyLoadedStyle verifies theme freshness before applying so a stale result
 * from a double-switch is discarded.
 */
export function reloadMapStyleForCurrentTheme(): void {
    // No map yet (user is on the landing page, initTripUi not called) - skip the
    // fetch; applyLoadedStyle would no-op anyway, but we also save the network request.
    if (viewerMaps.size === 0) return;
    const theme = currentMapTheme();
    const provider = getMapProvider();
    loadMapStyle(theme, false, "main", provider).then((style) => {
        if (style) applyLoadedStyle(style, theme, provider, true);
    });
}

// The failure banner lives with each surface; the registry owns whether the
// current style failed. A dismissed banner shows again on the next failure.
let isMapStyleErrorShown = false;
const mapStyleErrorListeners = createSubscribers<[isShown: boolean]>("map-style-error");

function showMapStyleError(): void {
    isMapStyleErrorShown = true;
    mapStyleErrorListeners.emit(true);
}

function hideMapStyleError(): void {
    isMapStyleErrorShown = false;
    mapStyleErrorListeners.emit(false);
}

/** Calls the listener now and on every style failure or recovery. */
export function subscribeMapStyleError(listener: (isShown: boolean) => void): () => void {
    return mapStyleErrorListeners.subscribe(listener, [isMapStyleErrorShown]);
}

/**
 * The banner's retry: refreshes the failed style even when it is the export's
 * palette, then applies it if it is the one the viewer shows.
 */
export function retryMapStyle(): Promise<void> {
    const theme = lastFailedStyle?.theme ?? currentMapTheme();
    const provider = lastFailedStyle?.provider ?? getMapProvider();
    const source = lastFailedStyle?.source ?? "main";
    return loadMapStyle(theme, true, source, provider).then((style) => {
        if (style) applyLoadedStyle(style, theme, provider);
    });
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
    if (viewerMaps.size === 0 || navigator.onLine === false) return;
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

function clearMapRecoveryTimer(): void {
    if (mapRecoveryTimer !== null) clearTimeout(mapRecoveryTimer);
    mapRecoveryTimer = null;
}

let areStyleSubscriptionsInstalled = false;

/** Style reloads and recovery start with the first map; the landing page needs neither. */
function installStyleSubscriptions(): void {
    if (areStyleSubscriptionsInstalled) return;
    areStyleSubscriptionsInstalled = true;

    let mapPreferences = getMapViewPreferences();
    subscribeMapViewPreferences((next) => {
        const needsStyle = next.style !== mapPreferences.style || next.theme !== mapPreferences.theme;
        mapPreferences = next;
        if (needsStyle) reloadMapStyleForCurrentTheme();
    });

    let wasOffline = isOffline();
    subscribeConnectivity((offline) => {
        if (offline) scheduleMapRecovery();
        else {
            clearMapRecoveryTimer();
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
        if (provider === "route-only") clearMapRecoveryTimer();
        scheduleMapRecovery();
        const theme = currentMapTheme();
        loadMapStyle(theme, false, "main", provider).then((style) => {
            if (style) applyLoadedStyle(style, theme, provider, true);
        });
    });
}

/**
 * Installs a transparent 1x1 stub for every icon the style asks for but the
 * sprite does not carry (Liberty references POI icons - running, office,
 * hospital - that its sprite omits). Without it MapLibre warnOnce's per missing
 * icon; with it the POIs simply render label-only. Shared by every live map.
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

function observeViewerMap(viewerMap: ViewerMap): void {
    const { map, surface } = viewerMap;
    // One diagnostic per provider/failure keeps offline tile misses bounded.
    const seenErrors = new Set<string>();
    const prefix = surface === "main" ? "" : `${surface} `;
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
        viewerMap.onContextLost?.();
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

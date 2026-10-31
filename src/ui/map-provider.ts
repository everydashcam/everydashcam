// The viewer shares a persisted preference and one page-scoped fallback chain.
// Export overlays have isolated sessions so viewer choices cannot enter a video.

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { createSubscribers } from "../subscribers.js";
import { createLogger } from "../log.js";
import { isYandexMapAvailable, yandexMapTileTemplate } from "./yandex-map.js";

const log = createLogger("map-provider");

export type MapProvider = "route-only" | "openfreemap" | "osm-vector" | "osm-raster" | "yandex";
export type MapProviderPreference = Exclude<MapProvider, "osm-raster">;
export type OverlayMapProviderPreference = Exclude<MapProviderPreference, "yandex">;
export type OverlayMapProvider = Exclude<MapProvider, "yandex">;

const STORAGE_KEY = "everydashcam:mapProvider";
const FAILURE_WINDOW_MS = 5_000;
const FAILURE_THRESHOLD = 2;
// A blocked host can leave fetch pending until the browser's network timeout.
export const MAP_PROVIDER_REQUEST_TIMEOUT_MS = 3_000;

const PROBE_URLS: Record<Exclude<OverlayMapProvider, "route-only">, string> = {
    openfreemap: "https://tiles.openfreemap.org/planet",
    "osm-vector": "https://vector.openstreetmap.org/shortbread_v1/0/0/0.mvt",
    "osm-raster": "https://tile.openstreetmap.org/0/0/0.png",
};

type ProviderListener<Provider extends MapProvider = MapProvider> = (
    provider: Provider,
    previous: Provider | null,
) => void;
type PreferenceListener = (preference: MapProviderPreference) => void;
type ProviderProbe = (provider: MapProvider) => Promise<boolean>;

interface MapProviderSession<Provider extends MapProvider> {
    getProvider(): Provider;
    subscribe(listener: ProviderListener<Provider>): () => void;
    reportTileError(error: unknown, now?: number): Promise<void> | null;
    dispose(): void;
}

interface MutableMapProviderSession<Provider extends MapProvider> extends MapProviderSession<Provider> {
    reset(provider: Provider, order?: readonly Provider[], shouldNotify?: boolean): void;
    retry(): Promise<boolean>;
}

export type OverlayMapProviderSession = MapProviderSession<OverlayMapProvider>;

let preferredProvider: MapProviderPreference | null = null;
let viewerSession: MutableMapProviderSession<MapProvider> | null = null;
const preferenceListeners = createSubscribers<Parameters<PreferenceListener>>("map-provider-preference");

function overlayProviderOrder(preference: OverlayMapProviderPreference): OverlayMapProvider[] {
    if (preference === "route-only") return ["route-only"];
    const order: OverlayMapProvider[] =
        preference === "osm-vector"
            ? ["osm-vector", "openfreemap", "osm-raster"]
            : ["openfreemap", "osm-vector", "osm-raster"];
    if (__PORTABLE__) order.push("route-only");
    return order;
}

function viewerProviderOrder(preference: MapProviderPreference): MapProvider[] {
    return preference === "yandex"
        ? ["yandex", ...overlayProviderOrder("openfreemap")]
        : overlayProviderOrder(preference);
}

function availablePreference(value: string | null | undefined): MapProviderPreference | null {
    if (__PORTABLE__ && value === "route-only") return value;
    if (value === "openfreemap" || value === "osm-vector") return value;
    return value === "yandex" && isYandexMapAvailable() ? value : null;
}

export function getMapProviderPreference(): MapProviderPreference {
    if (preferredProvider !== null) return preferredProvider;
    const defaultProvider = availablePreference(import.meta.env.VITE_DEFAULT_MAP_PROVIDER) ?? "openfreemap";
    preferredProvider = availablePreference(readLocalStorage(STORAGE_KEY)) ?? defaultProvider;
    return preferredProvider;
}

async function fetchProbe(provider: MapProvider): Promise<boolean> {
    if (provider === "route-only") return false;
    let url: string;
    if (provider === "yandex") {
        // A configured key alone must not trigger paid requests. Only recover
        // the user's selected Yandex map after every online source failed.
        if (!__PORTABLE__ || getMapProvider() !== "route-only" || getMapProviderPreference() !== "yandex") return false;
        const template = yandexMapTileTemplate();
        if (!template) return false;
        url = template.replace("{x}", "0").replace("{y}", "0").replace("{z}", "0");
    } else {
        url = PROBE_URLS[provider];
    }
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort("timeout"), MAP_PROVIDER_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: ctrl.signal,
            // An old cached tile cannot prove the service is reachable now.
            cache: "no-store",
        });
        if (!response.ok) return false;
        if (provider !== "openfreemap") return true;
        // A 200 error page must not replace a working local route with a
        // bootstrap that cannot supply any tiles.
        const tilejson: unknown = await response.json();
        return (
            typeof tilejson === "object" &&
            tilejson !== null &&
            "tiles" in tilejson &&
            Array.isArray(tilejson.tiles) &&
            tilejson.tiles.length > 0 &&
            tilejson.tiles.every(
                (tile: unknown) => typeof tile === "string" && ["https:", "http:"].includes(new URL(tile).protocol),
            )
        );
    } catch {
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
}

let probeProvider: ProviderProbe = fetchProbe;

function getViewerSession(): MutableMapProviderSession<MapProvider> {
    if (!viewerSession) {
        const preference = getMapProviderPreference();
        viewerSession = createProviderSession(preference, viewerProviderOrder(preference), probeProvider);
    }
    return viewerSession;
}

export function getMapProvider(): MapProvider {
    return getViewerSession().getProvider();
}

export function subscribeMapProvider(listener: ProviderListener): () => void {
    return getViewerSession().subscribe(listener);
}

/** Recover an automatic local fallback without reloading a still-offline map. */
export function retryMapProvider(): Promise<boolean> {
    if (getMapProviderPreference() === "route-only") return Promise.resolve(false);
    return getViewerSession().retry();
}

export function subscribeMapProviderPreference(listener: PreferenceListener): () => void {
    return preferenceListeners.subscribe(listener, [getMapProviderPreference()]);
}

function errorUrl(error: unknown): string | null {
    if (typeof error === "object" && error !== null) {
        const url = (error as { url?: unknown }).url;
        if (typeof url === "string") return url;
    }
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/https:\/\/[^\s)]+/);
    return match?.[0] ?? null;
}

/** Keep one diagnostic per provider/failure, rather than one per missing tile. */
export function mapProviderErrorKey(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const url = errorUrl(error);
    const provider = url ? mapProviderForTileUrl(url) : null;
    return provider && url ? message.replace(url, provider) : message;
}

export function mapProviderForTileUrl(rawUrl: string): MapProvider | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    // /planet is the TileJSON bootstrap; without it there are no tile URLs yet.
    if (url.hostname === "tiles.openfreemap.org") return "openfreemap";
    if (url.hostname === "vector.openstreetmap.org" && url.pathname.endsWith(".mvt")) return "osm-vector";
    if (url.hostname === "tile.openstreetmap.org" && url.pathname.endsWith(".png")) return "osm-raster";
    if (url.hostname === "tiles.api-maps.yandex.ru" && url.pathname.replace(/\/+$/, "") === "/v1/tiles") {
        return "yandex";
    }
    return null;
}

function isProviderBootstrapRequest(provider: MapProvider, rawUrl: string): boolean {
    if (provider !== "openfreemap") return false;
    try {
        return new URL(rawUrl).pathname.replace(/\/+$/, "") === "/planet";
    } catch {
        return false;
    }
}

function createProviderSession<Provider extends MapProvider>(
    initialProvider: Provider,
    initialOrder: readonly Provider[],
    probe: ProviderProbe,
): MutableMapProviderSession<Provider> {
    let activeProvider = initialProvider;
    let order = initialOrder;
    let failedTiles = new Map<string, number>();
    let transitionPromise: Promise<void> | null = null;
    let recoveryPromise: Promise<boolean> | null = null;
    let providerRevision = 0;
    let isDisposed = false;
    const listeners = createSubscribers<Parameters<ProviderListener<Provider>>>("map-provider-session");

    function switchProvider(next: Provider, shouldNotify = false): void {
        const previous = activeProvider;
        activeProvider = next;
        providerRevision++;
        failedTiles = new Map();
        if (next === previous && !shouldNotify) return;
        log.warn("map provider switched", { from: previous, to: next });
        listeners.emit(next, previous);
    }

    async function tryProviders(
        candidates: readonly Provider[],
        previous: Provider,
        expectedRevision: number,
    ): Promise<boolean> {
        for (const provider of candidates) {
            // The terminal fallback needs no network and must also work offline.
            if (provider === "route-only") {
                if (isDisposed || providerRevision !== expectedRevision || activeProvider !== previous) return false;
                switchProvider(provider);
                return true;
            }
            log.info("map provider probe", { provider });
            const isAvailable = await probe(provider);
            if (isDisposed || providerRevision !== expectedRevision || activeProvider !== previous) return false;
            log.info("map provider probe result", { provider, available: isAvailable });
            if (isAvailable) {
                switchProvider(provider);
                return true;
            }
        }
        return false;
    }

    async function downgradeProvider(failedProvider: Provider, expectedRevision: number): Promise<void> {
        await tryProviders(order.slice(order.indexOf(failedProvider) + 1), failedProvider, expectedRevision);
    }

    return {
        getProvider: () => activeProvider,
        subscribe(listener): () => void {
            if (isDisposed) return () => {};
            return listeners.subscribe(listener, [activeProvider, null]);
        },
        reportTileError(error, now = Date.now()): Promise<void> | null {
            if (isDisposed) return null;
            const url = errorUrl(error);
            const failedProvider = url ? mapProviderForTileUrl(url) : null;
            if (!url || failedProvider !== activeProvider || (activeProvider === "osm-raster" && !__PORTABLE__))
                return null;
            for (const [failedUrl, failedAt] of failedTiles) {
                if (now - failedAt > FAILURE_WINDOW_MS) failedTiles.delete(failedUrl);
            }
            failedTiles.set(url, now);
            const isYandexDenied =
                failedProvider === "yandex" &&
                typeof error === "object" &&
                error !== null &&
                "status" in error &&
                (error.status === 403 || error.status === 429);
            // A missing bootstrap or rejected API key/quota is conclusive even
            // when the whole viewport fits in a single distinct tile.
            const threshold = isProviderBootstrapRequest(failedProvider, url) || isYandexDenied ? 1 : FAILURE_THRESHOLD;
            if (failedTiles.size < threshold || transitionPromise) return transitionPromise;
            const distinctRequests = failedTiles.size;
            failedTiles = new Map();
            log.warn("map provider error threshold reached", {
                provider: failedProvider,
                distinctRequests,
                threshold,
                windowMs: FAILURE_WINDOW_MS,
            });
            const transition = downgradeProvider(activeProvider, providerRevision).finally(() => {
                if (transitionPromise === transition) transitionPromise = null;
            });
            transitionPromise = transition;
            return transitionPromise;
        },
        retry(): Promise<boolean> {
            if (isDisposed || activeProvider !== "route-only" || order[0] === "route-only")
                return Promise.resolve(false);
            if (recoveryPromise) return recoveryPromise;
            const recovery = tryProviders(
                order.filter((provider) => provider !== "route-only"),
                activeProvider,
                providerRevision,
            ).finally(() => {
                if (recoveryPromise === recovery) recoveryPromise = null;
            });
            recoveryPromise = recovery;
            return recovery;
        },
        reset(provider, nextOrder = order, shouldNotify = false): void {
            if (isDisposed) return;
            order = nextOrder;
            transitionPromise = null;
            recoveryPromise = null;
            // Increment even on a no-op so a late probe cannot undo a user choice.
            switchProvider(provider, shouldNotify);
        },
        dispose(): void {
            isDisposed = true;
            providerRevision++;
            transitionPromise = null;
            recoveryPromise = null;
            failedTiles.clear();
            listeners.clear();
        },
    };
}

/** Export sessions cannot select Yandex, including through fallback or viewer changes. */
export function createOverlayMapProviderSession(
    preference: OverlayMapProviderPreference = "openfreemap",
): OverlayMapProviderSession {
    // Runtime validation also covers malformed persisted values and JS callers.
    const safePreference = preference === "route-only" || preference === "osm-vector" ? preference : "openfreemap";
    return createProviderSession(safePreference, overlayProviderOrder(safePreference), probeProvider);
}

/** Two distinct failed tiles trigger fallback; stale-provider failures are ignored. */
export function reportMapProviderTileError(error: unknown, now = Date.now()): Promise<void> | null {
    return getViewerSession().reportTileError(error, now);
}

/** Store the user's first choice and immediately retry it on the current page. */
export function setMapProviderPreference(provider: MapProviderPreference): void {
    if (provider !== "route-only" && provider !== "openfreemap" && provider !== "osm-vector" && provider !== "yandex") {
        throw new Error("unknown map provider");
    }
    if (provider === "yandex" && !isYandexMapAvailable()) throw new Error("yandex map key is not configured");
    const session = getViewerSession();
    preferredProvider = provider;
    writeLocalStorage(STORAGE_KEY, provider);
    session.reset(provider, viewerProviderOrder(provider));
    preferenceListeners.emit(provider);
}

/** Page-scoped DevTools override. A reload restores the saved preference. */
export function forceMapProvider(provider: MapProvider): MapProvider {
    if (
        provider !== "route-only" &&
        provider !== "openfreemap" &&
        provider !== "osm-vector" &&
        provider !== "osm-raster" &&
        provider !== "yandex"
    ) {
        throw new Error("unknown map provider");
    }
    if (provider === "yandex" && !isYandexMapAvailable()) throw new Error("yandex map key is not configured");
    getViewerSession().reset(provider, provider === "yandex" ? viewerProviderOrder(provider) : undefined, true);
    return getMapProvider();
}

/** Test-only reset for the module-level page session. */
export function _resetForTests(probe: ProviderProbe = fetchProbe): void {
    viewerSession?.dispose();
    viewerSession = null;
    preferredProvider = null;
    probeProvider = probe;
    preferenceListeners.clear();
}

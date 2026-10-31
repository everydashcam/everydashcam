// Workbox owns cache revisions, installation, routing and expiration. Updates
// wait for every controlled window to close: local recordings cannot reload.
import { clientsClaim, type WorkboxPlugin } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { PrecacheController, PrecacheRoute, type PrecacheEntry } from "workbox-precaching";
import { registerRoute, setCatchHandler } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import { PRECACHE, RUNTIME, TRACKER } from "./sw-cache.js";
import {
    isCacheableAssetResponse,
    isCacheableResponse,
    isHtmlResponse,
    precacheRequest,
    trackerCacheUrl,
    validatePrecacheResponse,
} from "./sw-policy.js";
import { offlineResponse } from "./sw-offline.js";
import { migrateLegacyTrackerCache, TRACKER_MAX_ENTRIES } from "./sw-tracker-cache.js";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };

const manifest = self.__WB_MANIFEST.map((entry) =>
    typeof entry === "string" ? { url: entry, revision: null } : entry,
);
const entries = new Map(manifest.map((entry) => [new URL(entry.url, self.location.origin).href, entry]));
function entryFor(request: Request): PrecacheEntry | undefined {
    const url = new URL(request.url);
    url.search = "";
    return entries.get(url.href);
}

const precache = new PrecacheController({
    cacheName: PRECACHE,
    plugins: [
        {
            async handlerWillStart({ request, state }) {
                if (state) state.isNavigation = request.mode === "navigate";
            },
            async requestWillFetch({ request, state }) {
                if (state) state.hasAttemptedNetwork = true;
                const entry = entryFor(request);
                return entry ? precacheRequest(request, entry) : request;
            },
            async fetchDidSucceed({ request, response, event, state }) {
                const entry = entryFor(request);
                if (!entry) return response;
                try {
                    await validatePrecacheResponse(response, entry);
                } catch (error) {
                    if (event?.type === "install" || !state?.isNavigation || entry.integrity) throw error;
                    // An evicted shell may now belong to a newer deployment. Serve
                    // it online without storing it under this worker's revision.
                    return validatePrecacheResponse(response, entry, true);
                }
                if (state) state.networkResponse = response;
                // Workbox repairs SRI assets itself. HTML uses a marker because the
                // hosting edge injects analytics, so persist its verified fallback here.
                if (!entry.integrity && event?.type !== "install") {
                    const key = precache.getCacheKeyForURL(entry.url);
                    if (key) {
                        const copy = response.clone();
                        event?.waitUntil(
                            caches
                                .open(PRECACHE)
                                .then((cache) => cache.put(key, copy))
                                .catch(() => {}),
                        );
                    }
                }
                return response;
            },
            async cacheWillUpdate({ response }) {
                return isCacheableResponse(response) ? response : null;
            },
            async handlerDidError({ request, event, error, state }) {
                // A storage failure cannot bypass the complete-install requirement.
                // An already active worker can still serve verified network bytes.
                const entry = entryFor(request);
                if (event?.type === "install" || !entry) throw error;
                if (state?.networkResponse) return state.networkResponse;
                if (state?.hasAttemptedNetwork) throw error;
                return validatePrecacheResponse(
                    await fetch(precacheRequest(request, entry)),
                    entry,
                    request.mode === "navigate",
                );
            },
        },
    ],
});
precache.precache(manifest);
clientsClaim();

// One-time migration to Workbox ownership. Only old resource caches are removed;
// annotations, preferences, map tiles and other apps' caches remain independent.
self.addEventListener("activate", (event) => {
    event.waitUntil(
        Promise.all(
            ["everydashcam-precache-v4", "everydashcam-runtime-v3", "everydashcam-releases-v1"].map((name) =>
                caches.delete(name),
            ),
        ).catch(() => {}),
    );
    event.waitUntil(migrateLegacyTrackerCache().catch(() => {}));
});

const cacheable: WorkboxPlugin = {
    async requestWillFetch({ request, state }) {
        if (state) {
            // SWR starts its fetch before reading storage. Keep that result for
            // cache failures, including failures while the fetch is still pending.
            state.networkResponse = new Promise<Response | undefined>((resolve) => {
                state.finishFetch = resolve;
            });
        }
        return request;
    },
    async fetchDidSucceed({ response, state }) {
        state?.finishFetch(response);
        return response;
    },
    async fetchDidFail({ state }) {
        state?.finishFetch(undefined);
    },
    async cacheWillUpdate({ response }) {
        return isCacheableResponse(response) ? response : null;
    },
    async handlerDidError({ request, state, error }) {
        if (state?.networkResponse) {
            const response = await state.networkResponse;
            if (response) return response;
            throw error;
        }
        // CacheFirst can fail to read storage before trying the network.
        return fetch(request);
    },
};
const runtimeExpiration = new ExpirationPlugin({ maxEntries: 60, purgeOnQuotaError: true });
const immutableAssets = new CacheFirst({
    cacheName: RUNTIME,
    plugins: [
        {
            ...cacheable,
            async cacheWillUpdate({ response }) {
                return isCacheableAssetResponse(response) ? response : null;
            },
            async cachedResponseWillBeUsed({ cachedResponse }) {
                return cachedResponse && !isHtmlResponse(cachedResponse) ? cachedResponse : null;
            },
        },
        runtimeExpiration,
    ],
});
const pages = new NetworkFirst({
    cacheName: RUNTIME,
    plugins: [
        {
            async cacheKeyWillBeUsed({ request }) {
                // Static pages share bytes across tracking/query parameters.
                // Canonical keys also keep Workbox's LRU timestamps aligned.
                const url = new URL(request.url);
                url.search = "";
                return url.href;
            },
            async requestWillFetch({ request, state }) {
                // Workbox's networkTimeoutSeconds waits for the network when
                // this exact page has no cached response. Bound that miss too,
                // so an unreachable deep link falls back to its locale shell.
                const controller = new AbortController();
                // AbortSignal.any is newer than our supported Safari/Chromium.
                const abort = () => controller.abort();
                if (request.signal.aborted) abort();
                else request.signal.addEventListener("abort", abort, { once: true });
                const timeout = setTimeout(() => controller.abort(), 2500);
                if (state) state.timeout = timeout;
                return new Request(request, {
                    signal: controller.signal,
                });
            },
            async fetchDidSucceed({ response, state }) {
                // Headers arrived: let a slow response body finish streaming.
                clearTimeout(state?.timeout);
                if (response.status >= 500) throw new Error(`navigation request failed: ${response.status}`);
                return response;
            },
            async fetchDidFail({ state }) {
                clearTimeout(state?.timeout);
            },
            cacheWillUpdate: cacheable.cacheWillUpdate,
        },
        runtimeExpiration,
    ],
});
const optional = new StaleWhileRevalidate({ cacheName: RUNTIME, plugins: [cacheable, runtimeExpiration] });
const tracker = new CacheFirst({
    cacheName: TRACKER,
    matchOptions: { ignoreVary: true },
    plugins: [
        {
            ...cacheable,
            async handlerWillStart({ request, state }) {
                if (state) state.shouldRepair = request.headers.get("x-everydashcam-wasm-repair") === "1";
            },
            async cacheKeyWillBeUsed({ request }) {
                return trackerCacheUrl(request.url);
            },
            async cachedResponseWillBeUsed({ cacheName, request, cachedResponse, state }) {
                if (!cachedResponse) return null;
                if (!state?.shouldRepair && !isHtmlResponse(cachedResponse)) return cachedResponse;
                await caches
                    .open(cacheName)
                    .then((cache) => cache.delete(request, { ignoreVary: true }))
                    .catch(() => {});
                return null;
            },
            async cacheWillUpdate({ response }) {
                return isCacheableAssetResponse(response) ? response : null;
            },
        },
        new ExpirationPlugin({ maxEntries: TRACKER_MAX_ENTRIES, purgeOnQuotaError: true }),
    ],
});

function handles(request: Request, url: URL): boolean {
    return (
        url.origin === self.location.origin &&
        !request.headers.has("range") &&
        !url.pathname.startsWith("/downloads/") &&
        url.pathname !== "/deployment-assets.json"
    );
}

let repair: Promise<void> | undefined;
function repairOfflineGraph(event: ExtendableEvent): void {
    if (!navigator.onLine) return;
    repair ??= (async () => {
        // Workbox reads cached responses without buffering or rehashing them.
        // The normal strategy repairs missing entries using their SRI/marker.
        for (const [url, cacheKey] of precache.getURLsToCacheKeys()) {
            await Promise.all(
                precache.strategy.handleAll({
                    event,
                    request: new Request(url),
                    params: { cacheKey, integrity: precache.getIntegrityForCacheKey(cacheKey) },
                }),
            ).catch(() => {});
        }
    })().finally(() => {
        repair = undefined;
    });
    event.waitUntil(repair);
}

const precacheRoute = new PrecacheRoute(precache, { ignoreURLParametersMatching: [/.*/], cleanURLs: false });
registerRoute(
    (options) => handles(options.request, options.url) && precacheRoute.match(options),
    async (options) => {
        if (options.request.mode === "navigate") repairOfflineGraph(options.event);
        return precacheRoute.handler.handle(options);
    },
);
registerRoute(
    ({ request, url }) => handles(request, url) && request.mode === "navigate",
    async (options) => {
        repairOfflineGraph(options.event);
        return pages.handle(options);
    },
);
registerRoute(({ request, url }) => handles(request, url) && /^\/(?:ort|models)\//.test(url.pathname), tracker);
registerRoute(
    ({ request, url }) => handles(request, url) && /^\/(?:assets|fonts|styles)\//.test(url.pathname),
    immutableAssets,
);
registerRoute(({ request, url }) => handles(request, url), optional);

setCatchHandler(async ({ request }) => {
    if (request.mode !== "navigate") return Response.error();
    const locale = `/${new URL(request.url).pathname.split("/").filter(Boolean)[0]}/`;
    try {
        return (await precache.matchPrecache(locale)) ?? (await precache.matchPrecache("/en/")) ?? offlineResponse();
    } catch {
        return offlineResponse();
    }
});

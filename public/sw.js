// Offline app shell. Build-time injection owns the complete boot/run graph.
// Each precache key includes its content revision: a waiting or failed update
// cannot replace the active worker's HTML with a different chunk graph.
// Updates never skipWaiting because local recordings cannot survive a reload.

const PRECACHE_MANIFEST = []; // __DC_PRECACHE_MANIFEST__
const TRACKER_ASSET_URLS = []; // __DC_TRACKER_ASSET_URLS__

const SCHEMA = "v4";
const PRECACHE = `everydashcam-precache-${SCHEMA}`;
const RUNTIME = "everydashcam-runtime-v3";
const TRACKER = "everydashcam-tracker-v3";
const REVISION_PARAM = "__dc_revision";
const MANIFEST_KEY = "/__dc-precache-manifest__";
const MAX_RUNTIME_ENTRIES = 60;
const NAV_NETWORK_TIMEOUT_MS = 2500;
const PRECACHE_FETCH_TIMEOUT_MS = 10000;
const PRECACHE_CONCURRENCY = 6;

const toAbs = (url) => new URL(url, self.location.origin).toString();
const PRECACHE_ENTRIES = new Map(PRECACHE_MANIFEST.map((entry) => [toAbs(entry.url), entry]));
const PRECACHE_URLS = new Set(PRECACHE_ENTRIES.keys());
const TRACKER_URLS = new Set(TRACKER_ASSET_URLS.map(toAbs));
const LOCALE_SHELLS = PRECACHE_MANIFEST.map((entry) => entry.url).filter((url) => /^\/[a-z]{2}\/$/.test(url));

function precacheKey(entry) {
    const url = new URL(entry.url, self.location.origin);
    url.searchParams.set(REVISION_PARAM, entry.revision);
    return url.href;
}

function bareUrl(input) {
    const url = new URL(typeof input === "string" ? input : input.url, self.location.origin);
    url.search = "";
    return url.href;
}

// This page has no external dependencies, including after Cache Storage eviction.
const OFFLINE_FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>everydashcam</title><style>html,body{margin:0;height:100%;background:#0a0a0a;color:#f5f4f1;font:16px/1.5 system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}.dc-b{max-width:30rem;padding:2rem}h1{color:#ff9000;font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1.5rem;color:#bdbdbd}button{background:#ff9000;color:#000;border:0;border-radius:.5rem;padding:.75rem 1.5rem;font:inherit;font-weight:600;cursor:pointer}</style></head><body><div class="dc-b"><h1 id="dc-t"></h1><p id="dc-m"></p><button id="dc-r"></button></div><script>(function(){var ru=(navigator.language||"").toLowerCase().indexOf("ru")===0;document.getElementById("dc-t").textContent=ru?"Нет интернета":"You're offline";document.getElementById("dc-m").textContent=ru?"Сохранённой копии приложения сейчас нет на устройстве. Подключитесь к интернету один раз — и она восстановится сама.":"The saved copy of the app isn't on this device right now. Connect to the internet once and it will restore itself.";var b=document.getElementById("dc-r");b.textContent=ru?"Повторить":"Retry";b.onclick=function(){location.reload()};addEventListener("online",function(){location.reload()})})()</script></body></html>`;

function htmlAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

function htmlRevision(html) {
    for (const [tag] of html.matchAll(/<meta\s[^>]*>/gi)) {
        if (htmlAttribute(tag, "name") !== "dc-precache-revision") continue;
        const revision = htmlAttribute(tag, "content");
        return /^[a-f0-9]{16}$/.test(revision ?? "") ? revision : undefined;
    }
    return undefined;
}

async function readPrecacheBody(res, progress) {
    const reader = res.clone().body?.getReader();
    if (!reader) return new ArrayBuffer(0);
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            progress();
            chunks.push(value);
            size += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes.buffer;
}

// Bound inactivity, not total download time: slow connections that keep making
// progress must still finish the offline graph. Verify bytes before pinning a
// revision; Cloudflare may append analytics to HTML, so shells use a build marker.
async function fetchForPrecache(entry) {
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
        const ctrl = new AbortController();
        let timer;
        const progress = () => {
            clearTimeout(timer);
            timer = setTimeout(() => ctrl.abort(), PRECACHE_FETCH_TIMEOUT_MS);
        };
        progress();
        try {
            const cache = entry.url.startsWith("/assets/") && i === 0 ? "force-cache" : "reload";
            const res = await fetch(new Request(entry.url, { cache }), { signal: ctrl.signal });
            if (res.status !== 200 || res.redirected) throw new Error(`precache ${entry.url}: invalid response`);
            const bytes = await readPrecacheBody(res, progress);
            clearTimeout(timer);
            if (entry.htmlRevision) {
                if (htmlRevision(new TextDecoder().decode(bytes)) !== entry.htmlRevision) {
                    throw new Error(`precache ${entry.url}: shell revision mismatch`);
                }
            } else {
                const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
                const revision = [...digest]
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("")
                    .slice(0, 16);
                if (revision !== entry.revision) throw new Error(`precache ${entry.url}: revision mismatch`);
            }
            return res;
        } catch (err) {
            ctrl.abort();
            if (i === attempts - 1) throw err;
        } finally {
            clearTimeout(timer);
        }
        await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
    }
}

async function reconcilePrecache() {
    const cache = await caches.open(PRECACHE);
    const entries = PRECACHE_MANIFEST.values();
    const missing = [];
    await Promise.all(
        Array.from({ length: Math.min(PRECACHE_CONCURRENCY, PRECACHE_MANIFEST.length) }, async () => {
            for (const entry of entries) {
                try {
                    const key = precacheKey(entry);
                    if (await cache.match(key)) continue;
                    await cache.put(key, await fetchForPrecache(entry));
                } catch {
                    missing.push(entry.url);
                }
            }
        }),
    );
    if (missing.length > 0) throw new Error(`precache incomplete: ${missing.join(", ")}`);
}

self.addEventListener("install", (event) => {
    // Every manifest entry is required. A cached root without its locale shell
    // cannot launch offline, even if all JavaScript downloads succeeded.
    event.waitUntil(reconcilePrecache());
});

let repairPromise;
function repairPrecache(evt) {
    if (PRECACHE_MANIFEST.length === 0) return;
    // An unchanged sw.js never installs again after browser cache eviction.
    // Online navigation repairs missing entries, including unused lazy workers.
    if (!repairPromise) {
        repairPromise = reconcilePrecache()
            .catch(() => {})
            .finally(() => {
                repairPromise = undefined;
            });
    }
    evt.waitUntil(repairPromise);
}

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            try {
                const cache = await caches.open(PRECACHE);
                const runtime = await caches.open(RUNTIME);
                const valid = new Set(PRECACHE_MANIFEST.map(precacheKey));
                // Preserve old immutable chunks for restored tabs before retiring
                // stale revisions. Stable old shells must not replace a
                // newer runtime navigation response.
                async function demote(source, keys) {
                    for (const req of keys) {
                        if (!new URL(req.url).pathname.startsWith("/assets/")) continue;
                        const res = await source.match(req);
                        if (res) await runtime.put(bareUrl(req), res);
                    }
                }
                const stale = (await cache.keys()).filter((req) => !valid.has(req.url));
                await demote(cache, stale);
                await Promise.all(stale.map((req) => cache.delete(req)));
                await trimCache(runtime);
                if (TRACKER_ASSET_URLS.length > 0) {
                    const tracker = await caches.open(TRACKER);
                    await Promise.all(
                        (await tracker.keys())
                            .filter((req) => !TRACKER_URLS.has(req.url))
                            .map((req) => tracker.delete(req)),
                    );
                }
            } catch {
                // Cleanup is best effort. A quota error while saving obsolete
                // chunks must not prevent the fully installed worker taking over.
            }
            await self.clients.claim();
        })(),
    );
});

// Cache Storage can become unavailable while a registration remains active.
// A cache failure must not prevent an otherwise successful network response.
async function openCache(name) {
    try {
        return await caches.open(name);
    } catch {
        return null;
    }
}

async function matchCache(cache, input, options) {
    try {
        return cache ? await cache.match(input, options) : undefined;
    } catch {
        return undefined;
    }
}

async function matchPrecache(input) {
    const entry = PRECACHE_ENTRIES.get(bareUrl(input));
    if (!entry) return undefined;
    return matchCache(await openCache(PRECACHE), precacheKey(entry));
}

self.addEventListener("fetch", (evt) => {
    const req = evt.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (
        url.origin !== self.location.origin ||
        url.pathname === MANIFEST_KEY ||
        url.pathname.startsWith("/downloads/")
    ) return;
    // Partial responses cannot be put into Cache Storage, and a cached full
    // response must not replace a requested media byte range.
    if (req.headers.has("range")) return;
    if (req.mode === "navigate") {
        evt.respondWith(navigationResponse(req, evt));
    } else if (
        PRECACHE_URLS.has(bareUrl(req)) ||
        url.pathname.startsWith("/assets/") ||
        url.pathname.startsWith("/fonts/")
    ) {
        evt.respondWith(cacheFirst(req, evt));
    } else if (url.pathname.startsWith("/ort/") || url.pathname.startsWith("/models/")) {
        // Dev URLs and assets introduced by a newer app are not in this
        // worker's manifest. Integrity repair must bypass their stale cache too.
        evt.respondWith(
            TRACKER_URLS.has(url.href) || req.headers.get("x-everydashcam-wasm-repair") === "1"
                ? trackerCacheFirst(req, evt)
                : staleWhileRevalidate(req, evt, TRACKER, false),
        );
    } else {
        evt.respondWith(staleWhileRevalidate(req, evt));
    }
});

async function navigationResponse(req, evt) {
    const runtime = await openCache(RUNTIME);
    if (!navigator.onLine) {
        const hit = await navigationCacheFallback(req, runtime);
        if (hit) return hit;
        // onLine is only a hint: a reachable LAN server may still work when
        // the OS connectivity probe reports offline.
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NAV_NETWORK_TIMEOUT_MS);
    try {
        const res = await fetch(req, { signal: ctrl.signal });
        const shell = PRECACHE_ENTRIES.get(bareUrl(req));
        if (res.ok && shell?.htmlRevision && !htmlRevision(await res.clone().text())) {
            throw new Error("navigation shell marker missing");
        }
        // Required routes may fail during an incomplete deployment; the
        // cached app remains usable even when the server responds with 404.
        if (res.status < 500 && (!shell || res.ok)) {
            cacheAndTrim(runtime, req, res, evt);
            if (res.ok) repairPrecache(evt);
            return res;
        }
    } catch {
        // Timeout or network failure: the complete cached shell is usable.
    } finally {
        clearTimeout(timer);
    }
    return (await navigationCacheFallback(req, runtime)) || offlineResponse();
}

async function navigationCacheFallback(req, runtime) {
    let hit = (await matchPrecache(req)) || (await matchCache(runtime, req));
    if (hit) return hit;
    hit = await matchCache(runtime, req, { ignoreSearch: true });
    if (hit) return hit;
    const segment = new URL(req.url).pathname.split("/").filter(Boolean)[0];
    const locale = `/${segment}/`;
    if (LOCALE_SHELLS.includes(locale)) {
        hit = (await matchPrecache(locale)) || (await matchCache(runtime, locale, { ignoreSearch: true }));
        if (hit) return hit;
    }
    // Never substitute the root redirect for a missing locale; it would loop.
    return (await matchPrecache("/en/")) || (await matchCache(runtime, "/en/", { ignoreSearch: true }));
}

function offlineResponse() {
    return new Response(OFFLINE_FALLBACK_HTML, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

async function cacheFirst(req, evt) {
    const hit = await matchPrecache(req);
    if (hit) return hit;
    const runtime = await openCache(RUNTIME);
    const cached = await matchCache(runtime, req);
    const isBinaryAsset = !PRECACHE_ENTRIES.get(bareUrl(req))?.htmlRevision;
    if (cached && (!isBinaryAsset || !isHtmlResponse(cached))) return cached;
    const res = await fetch(req);
    if (isBinaryAsset && isHtmlResponse(res)) return Response.error();
    cacheAndTrim(runtime, req, res, evt);
    return res;
}

async function trackerCacheFirst(req, evt) {
    const tracker = await openCache(TRACKER);
    // These versioned same-origin files have identical bytes for main-thread
    // warming and worker imports, even when the server sends Vary: Origin.
    const hit = await matchCache(tracker, req, { ignoreVary: true });
    // Only the loader's integrity repair bypasses this immutable cache. Browser
    // reloads/tooling can set Request.cache=reload on otherwise ordinary reads.
    // Discard poisoned bytes even if offline, so a later download can repair them.
    if (hit && req.headers.get("x-everydashcam-wasm-repair") !== "1" && !isHtmlResponse(hit)) return hit;
    if (hit) {
        try {
            await tracker.delete(req, { ignoreVary: true });
        } catch {
            /* Storage is optional. */
        }
    }
    try {
        const res = await fetch(req);
        if (isHtmlResponse(res)) return Response.error();
        cacheAndTrim(tracker, req, res, evt, false);
        return res;
    } catch {
        return Response.error();
    }
}

async function staleWhileRevalidate(req, evt, cacheName = RUNTIME, trim = true) {
    const cache = await openCache(cacheName);
    const hit = await matchCache(cache, req);
    const cached = cacheName === TRACKER && hit && isHtmlResponse(hit) ? undefined : hit;
    const networkPromise = fetch(req)
        .then((res) => {
            if (cacheName === TRACKER && isHtmlResponse(res)) return null;
            cacheAndTrim(cache, req, res, evt, trim);
            return res;
        })
        .catch(() => null);
    if (cached) {
        evt.waitUntil(networkPromise);
        return cached;
    }
    return (await networkPromise) || Response.error();
}

function isHtmlResponse(res) {
    return /(?:text\/html|application\/xhtml\+xml)/i.test(res.headers.get("content-type") ?? "");
}

function cacheAndTrim(cache, req, res, evt, trim = true) {
    if (!cache || res.status !== 200 || res.type !== "basic" || res.redirected) return;
    const cloned = res.clone();
    evt.waitUntil(
        (async () => {
            try {
                await cache.put(req, cloned);
                if (trim) await trimCache(cache);
            } catch {
                // Storage/quota failures only reduce future offline coverage.
            }
        })(),
    );
}

async function trimCache(cache) {
    const keys = await cache.keys();
    const overflow = keys.length - MAX_RUNTIME_ENTRIES;
    if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((req) => cache.delete(req)));
}

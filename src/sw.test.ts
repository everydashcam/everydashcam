// Execute the browser worker with real response bodies and crypto, and a small
// in-memory CacheStorage boundary. Separate contexts can share the same caches
// to reproduce active/waiting workers across successful and failed updates.
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://everydashcam.app";
const SOURCE = readFileSync(resolve(__dirname, "../public/sw.js"), "utf-8");
const NAV_TIMEOUT_MS = Number(SOURCE.match(/NAV_NETWORK_TIMEOUT_MS = (\d+)/)?.[1]);
const PRECACHE_TIMEOUT_MS = Number(SOURCE.match(/PRECACHE_FETCH_TIMEOUT_MS = (\d+)/)?.[1]);
const abs = (url: string) => new URL(url, ORIGIN).href;
const revision = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);

interface Entry {
    url: string;
    revision: string;
    htmlRevision?: string;
}
interface CachedResponse {
    _tag: string;
    ok: boolean;
    status: number;
    type: string;
    redirected: boolean;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
    clone(): CachedResponse;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
}
function res(body: string, extra: Partial<CachedResponse> = {}): CachedResponse {
    return {
        _tag: body,
        ok: true,
        status: 200,
        type: "basic",
        redirected: false,
        headers: new Headers(),
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
            },
        }),
        clone: () => res(body, extra),
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
        text: async () => body,
        ...extra,
    };
}
function entry(url: string, body: string): Entry {
    return { url, revision: revision(body) };
}
function makeCache() {
    const entries = new Map<string, CachedResponse>();
    return {
        async match(input: string | { url: string }, options?: { ignoreSearch?: boolean }) {
            const url = abs(typeof input === "string" ? input : input.url);
            for (const [key, value] of entries) {
                if (key === url || (options?.ignoreSearch && key.split("?")[0] === url.split("?")[0])) {
                    return value.clone();
                }
            }
            return undefined;
        },
        async put(input: string | { url: string }, response: CachedResponse) {
            if (response.status === 206) throw new TypeError("partial response");
            entries.set(abs(typeof input === "string" ? input : input.url), response.clone());
        },
        async delete(input: string | { url: string }) {
            return entries.delete(abs(typeof input === "string" ? input : input.url));
        },
        async keys() {
            return [...entries.keys()].map((url) => ({ url }));
        },
    };
}
type MemoryCache = ReturnType<typeof makeCache>;
interface LoadOptions {
    onLine?: boolean;
    fetch?: (...args: never[]) => Promise<unknown>;
    pre?: Record<string, CachedResponse>;
    rt?: Record<string, CachedResponse>;
    tr?: Record<string, CachedResponse>;
    manifest?: Entry[];
    trackerUrls?: string[];
    storage?: Map<string, MemoryCache>;
    storageError?: boolean;
}
function event() {
    const background: Promise<unknown>[] = [];
    return {
        waitUntil(promise: Promise<unknown>) {
            background.push(promise);
        },
        async settled() {
            // A revalidation can append a cache write before it settles.
            for (let i = 0; i < background.length; i++) await background[i];
        },
    };
}
function loadSw(options: LoadOptions = {}) {
    const manifest =
        options.manifest ?? Object.entries(options.pre ?? {}).map(([url, response]) => entry(url, response._tag));
    const storage = options.storage ?? new Map<string, MemoryCache>();
    function cache(name: string) {
        let value = storage.get(name);
        if (!value) {
            value = makeCache();
            storage.set(name, value);
        }
        return value;
    }
    const listeners = new Map<string, (evt: unknown) => void>();
    const fetchSpy = vi.fn(options.fetch ?? (async () => res("network")));
    const context: Record<string, unknown> = {
        self: {
            addEventListener(type: string, fn: (evt: unknown) => void) {
                listeners.set(type, fn);
            },
            location: { origin: ORIGIN },
            clients: { claim: vi.fn() },
        },
        navigator: { onLine: options.onLine ?? true },
        caches: {
            async open(name: string) {
                if (options.storageError) throw new Error("storage disabled");
                return cache(name);
            },
            async keys() {
                return [...storage.keys()];
            },
            async delete(name: string) {
                return storage.delete(name);
            },
        },
        fetch: fetchSpy,
        URL,
        Request: class extends Request {
            constructor(input: string, init?: RequestInit) {
                super(abs(input), init);
            }
        },
        Response: class {
            constructor(body: string, init: ResponseInit = {}) {
                Object.assign(
                    this,
                    res(body, {
                        _tag: "offline-fallback",
                        status: init.status ?? 200,
                        headers: new Headers(init.headers),
                    }),
                );
            }
            static error() {
                return res("network-error", { ok: false, status: 0, type: "error" });
            }
        },
        crypto: webcrypto,
        TextDecoder,
        AbortController,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
    };
    vm.createContext(context);
    vm.runInContext(
        SOURCE.replace(
            /const PRECACHE_MANIFEST = \[\];\s*\/\/ __DC_PRECACHE_MANIFEST__/,
            `const PRECACHE_MANIFEST = ${JSON.stringify(manifest)};`,
        ).replace(
            /const TRACKER_ASSET_URLS = \[\];\s*\/\/ __DC_TRACKER_ASSET_URLS__/,
            `const TRACKER_ASSET_URLS = ${JSON.stringify(options.trackerUrls ?? [])};`,
        ),
        context,
    );
    const precacheKey = context.precacheKey as (entry: Entry) => string;
    const pre = cache("everydashcam-precache-v4");
    const rt = cache("everydashcam-runtime-v3");
    const tr = cache("everydashcam-tracker-v3");
    for (const [url, response] of Object.entries(options.pre ?? {})) {
        const current = manifest.find((item) => item.url === url);
        void pre.put(current ? precacheKey(current) : url, response);
    }
    for (const [url, response] of Object.entries(options.rt ?? {})) void rt.put(url, response);
    for (const [url, response] of Object.entries(options.tr ?? {})) void tr.put(url, response);
    const navRequest = (url: string) => ({ url: abs(url), mode: "navigate" });
    const navigationResponse = context.navigationResponse as (
        req: { url: string; mode: string },
        evt: ReturnType<typeof event>,
    ) => Promise<CachedResponse>;
    return {
        pre,
        rt,
        tr,
        storage,
        fetchSpy,
        precacheKey,
        async cached(url: string) {
            const current = manifest.find((item) => item.url === url);
            return pre.match(current ? precacheKey(current) : url);
        },
        async navigate(url: string) {
            const evt = event();
            const response = await navigationResponse(navRequest(url), evt);
            return { response, settled: () => evt.settled() };
        },
        async dispatchFetch(url: string, headers: HeadersInit = {}, mode = "same-origin", cache = "default") {
            const evt = event();
            let response: Promise<CachedResponse> | undefined;
            listeners.get("fetch")?.({
                ...evt,
                request: { method: "GET", url: abs(url), mode, cache, headers: new Headers(headers) },
                respondWith(value: Promise<CachedResponse>) {
                    response = value;
                },
            });
            return { response: await response, settled: () => evt.settled() };
        },
        async fire(type: "install" | "activate") {
            const evt = event();
            listeners.get(type)?.(evt);
            await evt.settled();
        },
    };
}
async function finishRetries(assertion: Promise<unknown>): Promise<void> {
    let isSettled = false;
    const results = await Promise.allSettled([
        assertion.finally(() => {
            isSettled = true;
        }),
        (async () => {
            while (!isSettled) {
                // Native crypto can schedule the next retry after the timer queue empties.
                await setImmediate();
                if (!isSettled) await vi.runAllTimersAsync();
            }
        })(),
    ]);
    for (const result of results) {
        if (result.status === "rejected") throw result.reason;
    }
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("service worker navigation", () => {
    it("leaves portable downloads and release metadata entirely to the network", async () => {
        const sw = loadSw({ pre: { "/en/": res("cached application") } });
        for (const path of [
            "/downloads/portable/latest.json",
            "/downloads/portable/v2026.09.25/dashcamigo-2026-09-25-en",
        ]) {
            for (const mode of ["same-origin", "navigate"]) {
                const result = await sw.dispatchFetch(path, {}, mode);
                await result.settled();
                expect(result.response).toBeUndefined();
            }
        }
        expect(sw.fetchSpy).not.toHaveBeenCalled();
        expect(await sw.rt.keys()).toEqual([]);
    });

    it("serves fresh online HTML while preserving the complete offline shell", async () => {
        const sw = loadSw({ pre: { "/ru/": res("cached") } });
        const result = await sw.navigate("/ru/?source=pwa");
        await result.settled();
        expect(result.response._tag).toBe("network");
        expect(sw.fetchSpy).toHaveBeenCalledTimes(1);
        expect((await sw.cached("/ru/"))?._tag).toBe("cached");
    });

    it("aborts a hung online navigation and serves the cached shell", async () => {
        vi.useFakeTimers();
        const sw = loadSw({
            pre: { "/ru/": res("cached") },
            fetch: (_req, init: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
                }),
        });
        const pending = sw.navigate("/ru/?source=pwa");
        await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS + 1);
        expect((await pending).response._tag).toBe("cached");
    });

    it("serves an offline cached shell without waiting for the network", async () => {
        const sw = loadSw({ onLine: false, pre: { "/ru/": res("cached") } });
        expect((await sw.navigate("/ru/?source=pwa")).response._tag).toBe("cached");
        expect(sw.fetchSpy).not.toHaveBeenCalled();
    });

    it("tries a reachable server when onLine is false and no cache exists", async () => {
        const sw = loadSw({ onLine: false });
        expect((await sw.navigate("/en/")).response._tag).toBe("network");
    });

    it("uses the locale home for an uncached offline subpage", async () => {
        const sw = loadSw({ onLine: false, pre: { "/ru/": res("cached") } });
        expect((await sw.navigate("/ru/cameras/70mai")).response._tag).toBe("cached");
    });

    it("uses a runtime locale shell when its precache entry is evicted", async () => {
        const sw = loadSw({ onLine: false, manifest: [entry("/ru/", "cached")], rt: { "/ru/": res("runtime") } });
        expect((await sw.navigate("/ru/cameras/70mai")).response._tag).toBe("runtime");
    });

    it("uses English when the requested locale shell is unavailable", async () => {
        const sw = loadSw({
            onLine: false,
            manifest: [entry("/ru/", "ru"), entry("/en/", "en")],
            pre: { "/en/": res("en") },
        });
        expect((await sw.navigate("/ru/")).response._tag).toBe("en");
    });

    it("returns the self-contained page without a root redirect loop after eviction", async () => {
        const sw = loadSw({
            onLine: false,
            pre: { "/": res("root") },
            fetch: async () => {
                throw new Error("offline");
            },
        });
        expect((await sw.navigate("/en/")).response._tag).toBe("offline-fallback");
    });

    it("uses the cached app during an HTTP server outage", async () => {
        const sw = loadSw({
            pre: { "/en/": res("cached") },
            fetch: async () => res("bad gateway", { ok: false, status: 502 }),
        });
        expect((await sw.navigate("/en/")).response._tag).toBe("cached");
    });

    it.each([
        { url: "/", status: 404 },
        { url: "/en/", status: 404 },
        { url: "/ru/", status: 403 },
    ])("serves the cached required shell $url when the server returns $status", async ({ url, status }) => {
        const sw = loadSw({
            pre: { [url]: res("cached") },
            fetch: async () => res("server error", { ok: false, status }),
        });
        const result = await sw.navigate(`${url}?source=pwa`);
        await result.settled();
        expect(result.response._tag).toBe("cached");
        expect(await sw.rt.match(`${url}?source=pwa`)).toBeUndefined();
    });

    it("preserves a real online not-found response", async () => {
        const sw = loadSw({
            pre: { "/en/": res("cached") },
            fetch: async () => res("not found", { ok: false, status: 404 }),
        });
        expect((await sw.navigate("/unknown")).response.status).toBe(404);
    });

    it("keeps online navigation working when Cache Storage is unavailable", async () => {
        const sw = loadSw({ storageError: true });
        expect((await sw.navigate("/en/")).response._tag).toBe("network");
    });

    it("serves the self-contained fallback when both network and storage fail", async () => {
        const sw = loadSw({
            storageError: true,
            fetch: async () => {
                throw new Error("offline");
            },
        });
        expect((await sw.navigate("/en/")).response._tag).toBe("offline-fallback");
    });
});

describe("service worker install and repair", () => {
    it.each(["/assets/app-AAAA.js", "/en/", "/", "/styles/light.json"])(
        "rejects an incomplete offline graph when %s is missing",
        async (url) => {
            vi.useFakeTimers();
            const sw = loadSw({
                manifest: [entry(url, "expected")],
                fetch: async () => res("not found", { ok: false, status: 404 }),
            });
            await finishRetries(expect(sw.fire("install")).rejects.toThrow("precache incomplete"));
            expect(await sw.cached(url)).toBeUndefined();
        },
    );

    it("does not overwrite the active shell when an update cannot download its code", async () => {
        vi.useFakeTimers();
        const storage = new Map<string, MemoryCache>();
        const old = loadSw({
            storage,
            onLine: false,
            pre: { "/en/": res("old-shell"), "/assets/old.js": res("old-code") },
        });
        const next = loadSw({
            storage,
            manifest: [entry("/en/", "new-shell"), entry("/assets/new.js", "new-code")],
            fetch: async (req: { url: string }) => {
                return req.url.endsWith("/en/") ? res("new-shell") : res("not found", { ok: false, status: 404 });
            },
        });
        await finishRetries(expect(next.fire("install")).rejects.toThrow("precache incomplete"));
        expect((await old.navigate("/en/")).response._tag).toBe("old-shell");
        expect((await old.dispatchFetch("/assets/old.js")).response?._tag).toBe("old-code");
        expect((await next.cached("/en/"))?._tag).toBe("new-shell");
    });

    it("retries a failed changed shell instead of labeling the old response fresh", async () => {
        vi.useFakeTimers();
        const storage = new Map<string, MemoryCache>();
        loadSw({ storage, pre: { "/en/": res("old-shell") } });
        const manifest = [entry("/en/", "new-shell")];
        const failed = loadSw({ storage, manifest, fetch: async () => res("not found", { ok: false, status: 404 }) });
        await finishRetries(expect(failed.fire("install")).rejects.toThrow("precache incomplete"));
        const retried = loadSw({ storage, manifest, fetch: async () => res("new-shell") });
        await retried.fire("install");
        expect(retried.fetchSpy).toHaveBeenCalledTimes(1);
        expect((await retried.cached("/en/"))?._tag).toBe("new-shell");
    });

    it("reuses unchanged revisions without downloading them again", async () => {
        const sw = loadSw({ pre: { "/en/": res("cached"), "/assets/app.js": res("code") } });
        await sw.fire("install");
        expect(sw.fetchSpy).not.toHaveBeenCalled();
    });

    it("reuses HTTP cache only for the first attempt at an immutable asset", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const sw = loadSw({
            manifest: [entry("/assets/app.js", "right-code")],
            fetch: async () => res(++calls === 1 ? "wrong-code" : "right-code"),
        });
        await finishRetries(expect(sw.fire("install")).resolves.toBeUndefined());
        expect(sw.fetchSpy.mock.calls.map(([req]) => (req as unknown as Request).cache)).toEqual([
            "force-cache",
            "reload",
        ]);
    });

    it("rejects a successful response with bytes from another deployment", async () => {
        vi.useFakeTimers();
        const sw = loadSw({
            manifest: [entry("/assets/app.js", "expected-code")],
            fetch: async () => res("<html>server fallback</html>"),
        });
        await finishRetries(expect(sw.fire("install")).rejects.toThrow("precache incomplete"));
        expect(await sw.cached("/assets/app.js")).toBeUndefined();
    });

    it("bounds a precache fetch whose connection never settles", async () => {
        vi.useFakeTimers();
        const sw = loadSw({
            manifest: [entry("/assets/app.js", "code")],
            fetch: (_req, init: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
                }),
        });
        const failure = expect(sw.fire("install")).rejects.toThrow("precache incomplete");
        await vi.advanceTimersByTimeAsync(PRECACHE_TIMEOUT_MS * 3 + 500);
        await failure;
        expect(sw.fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("repairs evicted lazy code after online navigation without reinstalling the worker", async () => {
        const sw = loadSw({
            manifest: [entry("/assets/lazy.js", "lazy")],
            fetch: async (req: { url: string }) => res(req.url.endsWith("lazy.js") ? "lazy" : "online-shell"),
        });
        const result = await sw.navigate("/en/");
        await result.settled();
        expect(result.response._tag).toBe("online-shell");
        expect((await sw.cached("/assets/lazy.js"))?._tag).toBe("lazy");
    });

    it("coalesces repairs from concurrent navigations", async () => {
        let finish: (value: CachedResponse) => void = () => {};
        const sw = loadSw({
            manifest: [entry("/assets/lazy.js", "lazy")],
            fetch: async (req: { url: string }) =>
                req.url.endsWith("lazy.js")
                    ? new Promise<CachedResponse>((resolve) => {
                          finish = resolve;
                      })
                    : res("online-shell"),
        });
        const first = await sw.navigate("/en/");
        const second = await sw.navigate("/ru/");
        finish(res("lazy"));
        await Promise.all([first.settled(), second.settled()]);
        expect(
            sw.fetchSpy.mock.calls.filter(([req]) => (req as unknown as Request).url.endsWith("lazy.js")),
        ).toHaveLength(1);
    });
});

describe("service worker response validation", () => {
    const marker = "0123456789abcdef";
    const shell = `<html><head><meta name="dc-precache-revision" content="${marker}"></head><body>app</body></html>`;
    const shellEntry = { ...entry("/en/", shell), htmlRevision: marker };

    it("accepts edge-injected analytics while verifying the shell build marker", async () => {
        const transformed = shell.replace("</body>", '<script src="https://example.com/beacon.js"></script></body>');
        const sw = loadSw({ manifest: [shellEntry], fetch: async () => res(transformed) });
        await sw.fire("install");
        expect((await sw.cached("/en/"))?._tag).toBe(transformed);
    });

    it("accepts an unquoted build marker preserved by an HTML minifier", async () => {
        const transformed = shell
            .replace('name="dc-precache-revision"', "name=dc-precache-revision")
            .replace(`content="${marker}"`, `content=${marker}`);
        const sw = loadSw({ manifest: [shellEntry], fetch: async () => res(transformed) });
        await sw.fire("install");
        expect((await sw.cached("/en/"))?._tag).toBe(transformed);
    });

    it("rejects a shell from another build during cache repair", async () => {
        vi.useFakeTimers();
        const transformed = shell.replace(marker, "fedcba9876543210");
        const sw = loadSw({ manifest: [shellEntry], fetch: async () => res(transformed) });
        const result = await sw.navigate("/en/");
        await finishRetries(expect(result.settled()).resolves.toBeUndefined());
        expect(result.response._tag).toBe(transformed);
        expect(await sw.cached("/en/")).toBeUndefined();
    });

    it("uses the cached shell when the network returns a captive portal page", async () => {
        const sw = loadSw({
            manifest: [shellEntry],
            pre: { "/en/": res(shell) },
            fetch: async () => res("<html>login to Wi-Fi</html>"),
        });
        const result = await sw.navigate("/en/");
        await result.settled();
        expect(result.response._tag).toBe(shell);
        expect(await sw.rt.match("/en/")).toBeUndefined();
    });

    it("does not pin an HTML fallback as a tracker download", async () => {
        const sw = loadSw({
            trackerUrls: ["/ort/current.wasm"],
            fetch: async () => res("<html>fallback</html>", { headers: new Headers({ "content-type": "text/html" }) }),
        });
        const result = await sw.dispatchFetch("/ort/current.wasm");
        await result.settled();
        expect(result.response?.type).toBe("error");
        expect(await sw.tr.match("/ort/current.wasm")).toBeUndefined();
    });

    it.each(["/ort/current.wasm", "/ort/dev.wasm"])("recovers from a poisoned HTML cache entry at %s", async (url) => {
        const sw = loadSw({
            trackerUrls: ["/ort/current.wasm"],
            tr: { [url]: res("<html>fallback</html>", { headers: new Headers({ "content-type": "text/html" }) }) },
        });
        const result = await sw.dispatchFetch(url);
        await result.settled();
        expect(result.response?._tag).toBe("network");
        expect((await sw.tr.match(url))?._tag).toBe("network");
    });

    it("recovers a code asset poisoned by a server HTML fallback", async () => {
        const sw = loadSw({
            rt: {
                "/assets/code.js": res("<html>fallback</html>", {
                    headers: new Headers({ "content-type": "text/html" }),
                }),
            },
        });
        const result = await sw.dispatchFetch("/assets/code.js");
        await result.settled();
        expect(result.response?._tag).toBe("network");
        expect((await sw.rt.match("/assets/code.js"))?._tag).toBe("network");
    });

    it("lets a slow progressing precache body complete beyond the stall timeout", async () => {
        vi.useFakeTimers();
        const sw = loadSw({
            manifest: [entry("/assets/slow.js", "abc")],
            fetch: async () => {
                let offset = 0;
                const body = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        if (offset === 3) {
                            controller.close();
                            return;
                        }
                        await new Promise((resolve) => setTimeout(resolve, PRECACHE_TIMEOUT_MS / 2));
                        controller.enqueue(new TextEncoder().encode("abc"[offset++]));
                    },
                });
                return res("abc", { body });
            },
        });
        const pending = sw.fire("install");
        await vi.advanceTimersByTimeAsync(PRECACHE_TIMEOUT_MS * 2);
        await pending;
        expect((await sw.cached("/assets/slow.js"))?._tag).toBe("abc");
        expect(sw.fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("aborts a precache body that stalls after successful response headers", async () => {
        vi.useFakeTimers();
        const sw = loadSw({
            manifest: [entry("/assets/stalled.js", "code")],
            fetch: async (_req, init: { signal: AbortSignal }) => {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
                    },
                });
                return res("code", { body });
            },
        });
        const failed = expect(sw.fire("install")).rejects.toThrow("precache incomplete");
        await vi.advanceTimersByTimeAsync(PRECACHE_TIMEOUT_MS * 3 + 500);
        await failed;
        expect(sw.fetchSpy).toHaveBeenCalledTimes(3);
    });
});

describe("service worker cache routes", () => {
    it("serves a runtime immutable asset before attempting a hung network", async () => {
        const sw = loadSw({ rt: { "/assets/old.js": res("cached") }, fetch: async () => new Promise(() => {}) });
        expect((await sw.dispatchFetch("/assets/old.js")).response?._tag).toBe("cached");
        expect(sw.fetchSpy).not.toHaveBeenCalled();
    });

    it("serves a precached style with a cache-busting query offline", async () => {
        const sw = loadSw({
            pre: { "/styles/light.json": res("style") },
            fetch: async () => {
                throw new Error("offline");
            },
        });
        expect((await sw.dispatchFetch("/styles/light.json?v=1")).response?._tag).toBe("style");
        expect(sw.fetchSpy).not.toHaveBeenCalled();
    });

    it.each(["/assets/new.js", "/ort/current.wasm", "/robots.txt"])(
        "serves %s online when storage is disabled",
        async (url) => {
            const sw = loadSw({ storageError: true, trackerUrls: [url] });
            expect((await sw.dispatchFetch(url)).response?._tag).toBe("network");
        },
    );

    it("passes an uncached not-found asset through without storing it", async () => {
        const sw = loadSw({ fetch: async () => res("not found", { ok: false, status: 404 }) });
        const result = await sw.dispatchFetch("/assets/missing.js");
        await result.settled();
        expect(result.response?.status).toBe(404);
        expect(await sw.rt.match("/assets/missing.js")).toBeUndefined();
    });

    it("lets range requests retain network byte-range semantics", async () => {
        const sw = loadSw({ rt: { "/example.mp4": res("full video") } });
        expect((await sw.dispatchFetch("/example.mp4", { range: "bytes=0-99" })).response).toBeUndefined();
    });

    it("ignores cache write failure while serving a successful response", async () => {
        const sw = loadSw();
        vi.spyOn(sw.rt, "put").mockRejectedValue(new Error("quota exceeded"));
        const result = await sw.dispatchFetch("/assets/app.js");
        await result.settled();
        expect(result.response?._tag).toBe("network");
    });

    it("serves an immutable tracker cache hit without another multi-megabyte download", async () => {
        const url = "/ort/1.27.0/ort.wasm";
        const sw = loadSw({ trackerUrls: [url], tr: { [url]: res("cached") } });
        expect((await sw.dispatchFetch(url)).response?._tag).toBe("cached");
        expect(sw.fetchSpy).not.toHaveBeenCalled();
    });

    it("stores a first tracker download in its dedicated cache", async () => {
        const url = "/ort/1.27.0/ort.wasm";
        const sw = loadSw({ trackerUrls: [url] });
        const result = await sw.dispatchFetch(url);
        await result.settled();
        expect((await sw.tr.match(url))?._tag).toBe("network");
        expect(await sw.rt.match(url)).toBeUndefined();
    });

    it("keeps ordinary browser reloads usable from the immutable tracker cache", async () => {
        const url = "/ort/current.wasm.part-0.bin";
        const sw = loadSw({ trackerUrls: [url], tr: { [url]: res("cached") } });
        expect((await sw.dispatchFetch(url, {}, "same-origin", "reload")).response?._tag).toBe("cached");
        expect(sw.fetchSpy).not.toHaveBeenCalled();
    });

    it.each([true, false])("replaces a corrupt tracker part on integrity repair (listed: %s)", async (listed) => {
        const url = "/ort/current.wasm.part-0.bin";
        const sw = loadSw({ trackerUrls: listed ? [url] : [], tr: { [url]: res("corrupt") } });
        const result = await sw.dispatchFetch(url, { "x-everydashcam-wasm-repair": "1" }, "same-origin", "reload");
        await result.settled();
        expect(result.response?._tag).toBe("network");
        expect((await sw.tr.match(url))?._tag).toBe("network");
    });

    it.each([true, false])("removes a poisoned tracker part when repair is offline (listed: %s)", async (listed) => {
        const url = "/ort/current.wasm.part-0.bin";
        const sw = loadSw({
            trackerUrls: listed ? [url] : [],
            tr: { [url]: res("corrupt") },
            fetch: async () => {
                throw new Error("offline");
            },
        });
        const result = await sw.dispatchFetch(url, { "x-everydashcam-wasm-repair": "1" }, "same-origin", "reload");
        expect(result.response?.type).toBe("error");
        expect(await sw.tr.match(url)).toBeUndefined();
    });

    it("revalidates unknown stable tracker URLs in the background", async () => {
        const sw = loadSw({ tr: { "/ort/dev.wasm": res("cached") } });
        const result = await sw.dispatchFetch("/ort/dev.wasm");
        await result.settled();
        expect(result.response?._tag).toBe("cached");
        expect((await sw.tr.match("/ort/dev.wasm"))?._tag).toBe("network");
    });

    it("returns an error response once when an uncached optional resource is offline", async () => {
        const sw = loadSw({
            fetch: async () => {
                throw new Error("offline");
            },
        });
        expect((await sw.dispatchFetch("/optional.png")).response?.type).toBe("error");
        expect(sw.fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe("service worker activation", () => {
    it("demotes old revisioned code without replacing the current shell", async () => {
        const storage = new Map<string, MemoryCache>();
        const old = loadSw({ storage, pre: { "/assets/old.js": res("old-code"), "/en/": res("old-shell") } });
        const sw = loadSw({
            storage,
            pre: { "/assets/new.js": res("new-code"), "/en/": res("new-shell") },
            rt: { "/en/": res("fresh-network-shell") },
        });
        await sw.fire("activate");
        expect((await sw.rt.match("/assets/old.js"))?._tag).toBe("old-code");
        expect(await old.cached("/assets/old.js")).toBeUndefined();
        expect((await sw.cached("/en/"))?._tag).toBe("new-shell");
        expect((await sw.rt.match("/en/"))?._tag).toBe("fresh-network-shell");
    });

    it("does not read or delete other caches", async () => {
        const sw = loadSw();
        for (const name of ["dashcamigo-precache-v4", "other-app"]) {
            const other = makeCache();
            await other.put("/assets/other.js", res("other cache"));
            sw.storage.set(name, other);
        }
        await sw.fire("activate");
        const result = await sw.dispatchFetch("/assets/other.js");
        await result.settled();
        expect(result.response?._tag).toBe("network");
        for (const name of ["dashcamigo-precache-v4", "other-app"]) {
            expect((await sw.storage.get(name)?.match("/assets/other.js"))?._tag).toBe("other cache");
        }
    });

    it("activates a complete worker when retiring old code exceeds storage quota", async () => {
        const sw = loadSw({ pre: { "/en/": res("shell") } });
        await sw.pre.put("/assets/stale.js", res("stale"));
        vi.spyOn(sw.rt, "put").mockRejectedValue(new Error("quota exceeded"));
        await expect(sw.fire("activate")).resolves.toBeUndefined();
        expect((await sw.cached("/en/"))?._tag).toBe("shell");
    });

    it("keeps current tracker downloads and removes superseded versions", async () => {
        const sw = loadSw({
            trackerUrls: ["/ort/new.wasm"],
            tr: { "/ort/new.wasm": res("new"), "/ort/old.wasm": res("old") },
        });
        await sw.fire("activate");
        expect((await sw.tr.match("/ort/new.wasm"))?._tag).toBe("new");
        expect(await sw.tr.match("/ort/old.wasm")).toBeUndefined();
    });

    it("preserves warmed tracker assets in development without an injected asset list", async () => {
        const sw = loadSw({ tr: { "/ort/dev.wasm": res("cached") } });
        await sw.fire("activate");
        expect((await sw.tr.match("/ort/dev.wasm"))?._tag).toBe("cached");
    });
});

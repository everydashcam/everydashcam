import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// Real worker lifecycle across releases on one origin and one browser profile.
// Tiny shells exercise the bundled Workbox worker on a real changing origin.
import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

import { buildServiceWorker } from "../helpers/service-worker-build.js";
const hash = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
async function release(id: string) {
    const code = `window.testGeneration=${JSON.stringify(id)};navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});`;
    const htmlRevision = hash(id);
    const html = `<!doctype html><meta name="dc-precache-revision" content="${htmlRevision}"><title>${id}</title><script src="/assets/generation-${id}.js"></script>`;
    const manifest = [
        { url: "/en/", revision: htmlRevision },
        {
            url: `/assets/generation-${id}.js`,
            revision: hash(code),
            integrity: `sha256-${createHash("sha256").update(code).digest("base64")}`,
        },
    ];
    const sw = await buildServiceWorker(manifest);
    return { code, html, sw };
}

/** The observer stays blank so it does not keep the old worker alive. */
async function closeForWorkerActivation(current: Page, observer: Page, origin: string): Promise<void> {
    // A replaced worker can lose its execution context during evaluation.
    // Observe browser lifecycle state from the surviving blank page instead.
    const session = await observer.context().newCDPSession(observer);
    const versions = new Map<string, string>();
    session.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => {
        for (const version of updates) {
            if (version.scriptURL === `${origin}/sw.js`) {
                versions.set(version.versionId, version.status);
            }
        }
    });
    try {
        await session.send("ServiceWorker.enable");
        const waitingVersions = () => [...versions].filter(([, status]) => status === "installed");
        await expect.poll(waitingVersions).toHaveLength(1);
        const [waitingVersionId] = waitingVersions()[0]!;
        await current.close();
        await expect.poll(() => versions.get(waitingVersionId)).toBe("activated");
    } finally {
        await session.detach();
    }
}

test.use({ serviceWorkers: "allow" });

test(
    "A to B to C and rollback preserve open clients, failed installs and offline launches",
    {
        tag: "@golden-offline",
    },
    async ({ playwright }, info) => {
        const profile = info.outputPath("browser-profile");
        const options = { channel: "chromium", headless: true, serviceWorkers: "allow" as const };
        let context = await playwright.chromium.launchPersistentContext(profile, options);
        let page = await context.newPage();
        test.setTimeout(120_000);
        const releases = { a: await release("a"), b: await release("b"), c: await release("c") };
        let published: keyof typeof releases = "a";
        let incomplete = false;
        let retained = new Set(["a"]);
        let offline = false;
        // Updated SW main scripts bypass Playwright routing. A real HTTP server
        // owns the published version, including update checks and installation.
        const server = createServer((request, response) => {
            if (offline) {
                response.destroy();
                return;
            }
            const path = new URL(request.url!, "http://localhost").pathname;
            const send = (body: string, type: string, status = 200) => {
                response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
                response.end(body);
            };
            if (path === "/setup") return send("<!doctype html><title>setup</title>", "text/html");
            if (path === "/sw.js") return send(releases[published].sw, "text/javascript");
            if (path === "/en/") return send(releases[published].html, "text/html");
            const id = path.match(/^\/assets\/generation-([abc])\.js$/)?.[1] as keyof typeof releases | undefined;
            if (id && retained.has(id) && !(incomplete && id === published))
                return send(releases[id].code, "text/javascript");
            const model = path.match(/^\/models\/([abc])\.onnx$/)?.[1];
            if (model && retained.has(model)) return send(path, "application/octet-stream");
            send("missing", "text/plain", 404);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            await page.goto(`${origin}/setup`);
            await page.evaluate(async () => {
                for (const name of [
                    "everydashcam-precache-v4",
                    "everydashcam-runtime-v3",
                    "everydashcam-tracker-v3",
                    "everydashcam-releases-v1",
                    "other-app",
                ]) {
                    await (await caches.open(name)).put("/old-resource", new Response("keep only unrelated storage"));
                }
                localStorage.setItem("keep-preference", "chosen");
            });
            await page.goto(`${origin}/en/`);
            await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
            await expect
                .poll(() =>
                    page.evaluate(async () =>
                        (await caches.keys()).filter((name) => /everydashcam-.*-v[134]$/.test(name)),
                    ),
                )
                .toEqual([]);
            expect(await page.evaluate(async () => caches.has("other-app"))).toBe(true);
            await page.evaluate(async () => {
                localStorage.setItem("keep-preference", "chosen");
                await fetch("/models/a.onnx");
            });
            published = "b";
            retained = new Set(["a", "b"]);
            incomplete = true;
            // Observe the actual installing worker reaching failure, not a timer guess.
            await page.evaluate(async () => {
                const registration = (await navigator.serviceWorker.getRegistration())!;
                const failed = new Promise<void>((resolve) =>
                    registration.addEventListener(
                        "updatefound",
                        () => {
                            const installing = registration.installing!;
                            installing.addEventListener("statechange", () => {
                                if (installing.state === "redundant") resolve();
                            });
                        },
                        { once: true },
                    ),
                );
                await registration.update();
                await failed;
            });
            await page.reload();
            expect(await page.title()).toBe("a");
            incomplete = false;
            const update = async () => {
                await page.evaluate(async () => {
                    await (await navigator.serviceWorker.getRegistration())!.update();
                });
                await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
            };
            await update();
            const other = await context.newPage();
            await other.goto(`${origin}/en/`);
            expect(await other.title()).toBe("a");
            expect(await page.title()).toBe("a");
            await other.close();
            const restart = async (expected: string) => {
                // There must be no controlled client left. Reload alone overlaps clients
                // and must not be used to force activation while a recording is open.
                const previous = page;
                page = await context.newPage();
                await closeForWorkerActivation(previous, page, origin);
                await page.goto(`${origin}/en/`);
                expect(await page.title()).toBe(expected);
                expect(await page.evaluate(() => localStorage.getItem("keep-preference"))).toBe("chosen");
            };
            await restart("b");
            await page.evaluate(async () => {
                await fetch("/models/b.onnx");
            });
            published = "c";
            retained = new Set(["b", "c"]);
            await update();
            await restart("c");
            expect(await page.evaluate(async () => (await fetch("/models/a.onnx")).text())).toBe("/models/a.onnx");
            await page.evaluate(async () => {
                for (const name of await caches.keys()) await (await caches.open(name)).delete("/models/a.onnx");
            });
            expect(await page.evaluate(async () => (await fetch("/models/a.onnx")).status)).toBe(404);
            // Reopen the actual on-disk profile with the server unavailable. This
            // checks persisted installation, not just a tab's live worker process.
            await context.close();
            offline = true;
            context = await playwright.chromium.launchPersistentContext(profile, options);
            page = await context.newPage();
            await page.goto(`${origin}/en/`);
            expect(await page.title()).toBe("c");
            expect(await page.evaluate(() => localStorage.getItem("keep-preference"))).toBe("chosen");
            offline = false;
            published = "b";
            await update();
            await restart("b");
            offline = true;
            await page.reload();
            expect(await page.title()).toBe("b");
            expect(await page.evaluate(async () => (await fetch("/models/b.onnx")).text())).toBe("/models/b.onnx");
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    },
);

test("serves deep links without AbortSignal.any and falls back from failed or stalled navigation", async ({ page }) => {
    const current = await release("fallback");
    let failPages = false;
    const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://localhost").pathname;
        const send = (body: string, type: string, status = 200) => {
            response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
            response.end(body);
        };
        if (path === "/sw.js") return send(`AbortSignal.any = undefined;\n${current.sw}`, "text/javascript");
        if (path === "/en/") return send(current.html, "text/html");
        if (path === "/assets/generation-fallback.js") return send(current.code, "text/javascript");
        if (path === "/en/stalled/") return;
        if (failPages) return send("server unavailable", "text/html", 503);
        send("<!doctype html><title>saved document</title>", "text/html");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await page.goto(`${origin}/en/`);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await page.goto(`${origin}/en/saved/?utm_source=online`);
        await expect(page).toHaveTitle("saved document");
        await page.waitForFunction(async () =>
            Boolean(await (await caches.open("everydashcam-runtime")).match("/en/saved/")),
        );
        failPages = true;
        await page.reload();
        await expect(page).toHaveTitle("saved document");
        await page.goto(`${origin}/en/saved/?utm_source=offline`);
        await expect(page).toHaveTitle("saved document");
        await page.goto(`${origin}/en/saved/`);
        await expect(page).toHaveTitle("saved document");
        expect(
            await page.evaluate(async () =>
                (await (await caches.open("everydashcam-runtime")).keys())
                    .map((request) => new URL(request.url))
                    .filter((url) => url.pathname === "/en/saved/")
                    .map((url) => url.search),
            ),
        ).toEqual([""]);
        await page.goto(`${origin}/en/uncached/`);
        await expect(page).toHaveTitle("fallback");
        await page.goto(`${origin}/en/stalled/`, { timeout: 10_000 });
        await expect(page).toHaveTitle("fallback");
    } finally {
        await page.goto("about:blank");
        await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
        });
    }
});

test("serves a newer online shell after eviction without assigning it the active worker revision", async ({ page }) => {
    const active = await release("active");
    const newer = await release("newer");
    let published = active;
    const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://localhost").pathname;
        response.setHeader("cache-control", "no-store");
        if (path === "/sw.js") {
            response.setHeader("content-type", "text/javascript");
            return response.end(active.sw);
        }
        if (path.startsWith("/assets/")) {
            response.setHeader("content-type", "text/javascript");
            return response.end(path.includes("newer") ? newer.code : active.code);
        }
        response.setHeader("content-type", "text/html");
        response.end(published.html);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await page.goto(`${origin}/en/`);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await page.evaluate(async () => {
            const cache = await caches.open("everydashcam-precache");
            for (const request of await cache.keys()) {
                if (new URL(request.url).pathname === "/en/") await cache.delete(request);
            }
        });
        published = newer;
        await page.reload();
        await expect(page).toHaveTitle("newer");
        expect(
            await page.evaluate(async () =>
                (await (await caches.open("everydashcam-precache")).keys()).some(
                    (request) => new URL(request.url).pathname === "/en/",
                ),
            ),
        ).toBe(false);
        published = active;
        await page.reload();
        await expect(page).toHaveTitle("active");
        await page.waitForFunction(async () =>
            Boolean(await (await caches.open("everydashcam-precache")).match("/en/", { ignoreSearch: true })),
        );
    } finally {
        await page.goto("about:blank");
        await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
        });
    }
});

test("fetches each resource once on network failure and still serves it when cache reads fail", async ({
    page,
    context,
}) => {
    const current = await release("network");
    const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://localhost").pathname;
        response.setHeader("cache-control", "no-store");
        if (path === "/sw.js") {
            response.setHeader("content-type", "text/javascript");
            return response.end(current.sw);
        }
        if (path === "/en/") {
            response.setHeader("content-type", "text/html");
            return response.end(current.html);
        }
        if (path === "/assets/generation-network.js") {
            response.setHeader("content-type", "text/javascript");
            return response.end(current.code);
        }
        if (path.endsWith("/unreachable")) return response.destroy();
        response.setHeader("content-type", "application/octet-stream");
        response.end("network response");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await page.goto(`${origin}/en/`);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        const worker = context.serviceWorkers().find((item) => item.url() === `${origin}/sw.js`)!;
        await worker.evaluate(() => {
            const originalFetch = globalThis.fetch;
            const calls: string[] = [];
            // Count Fetch API invocations, independent of browser HTTP retries.
            Object.assign(globalThis, { testFetchCalls: calls });
            globalThis.fetch = (input, init) => {
                calls.push(new Request(input, init).url);
                return originalFetch(input, init);
            };
        });
        for (const prefix of ["/assets", "/models", "/optional"]) {
            const path = `${prefix}/unreachable`;
            expect(
                await page.evaluate(
                    async (url) =>
                        fetch(url).then(
                            () => "success",
                            () => "failure",
                        ),
                    path,
                ),
            ).toBe("failure");
            expect(
                await worker.evaluate(
                    (url) =>
                        (Reflect.get(globalThis, "testFetchCalls") as string[]).filter((value) => value === url).length,
                    `${origin}${path}`,
                ),
            ).toBe(1);
        }
        await worker.evaluate(() => {
            caches.match = async () => {
                throw new DOMException("cache storage unavailable", "SecurityError");
            };
        });
        for (const path of ["/assets/available", "/models/available", "/optional/available"]) {
            expect(await page.evaluate(async (url) => (await fetch(url)).text(), path)).toBe("network response");
            expect(
                await worker.evaluate(
                    (url) =>
                        (Reflect.get(globalThis, "testFetchCalls") as string[]).filter((value) => value === url).length,
                    `${origin}${path}`,
                ),
            ).toBe(1);
        }
    } finally {
        await page.goto("about:blank");
        await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
        });
    }
});

/** Whether the document and a worker started from `workerUrl` are
 * cross-origin isolated. A worker script without COEP in an isolated document
 * fails with ERR_BLOCKED_BY_RESPONSE, which arrives as an error event. */
async function isolationOf(target: Page, workerUrl: string) {
    return target.evaluate(async (url) => {
        const worker = new Worker(url, { type: "module" });
        try {
            const workerIsolated = await new Promise<unknown>((resolve, reject) => {
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = () => reject(new Error(`worker ${url} did not start`));
            });
            return { document: crossOriginIsolated, worker: workerIsolated };
        } finally {
            worker.terminate();
        }
    }, workerUrl);
}

/** Embedder policy each precache entry was stored with, keyed by path. */
async function storedEmbedderPolicies(target: Page) {
    return target.evaluate(async () => {
        const cache = await caches.open("everydashcam-precache");
        const policies: Record<string, string> = {};
        for (const request of await cache.keys()) {
            const response = await cache.match(request);
            policies[new URL(request.url).pathname] = response?.headers.get("cross-origin-embedder-policy") ?? "none";
        }
        return policies;
    });
}

test("isolates a new tab and its workers when an update reuses files cached without isolation headers", {
    tag: "@golden-offline",
}, async ({ context, page }) => {
    // The previous worker build is not available here, but the state it
    // leaves is: Workbox stores network responses unchanged and keeps entries
    // whose URL and revision did not change. Only the worker changes between
    // these deployments, as when a release changes nothing but sw.js and
    // headers, so the shell and the worker script keep pre-isolation headers:
    // COOP, which hosting always sent, without COEP.
    const shellRevision = hash("isolation");
    const files = new Map([
        [
            "/en/",
            `<!doctype html><meta name="dc-precache-revision" content="${shellRevision}"><title>isolation</title><script src="/assets/isolation-shell.js"></script>`,
        ],
        [
            "/assets/isolation-shell.js",
            "navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});",
        ],
        ["/assets/isolation-worker.js", "postMessage(self.crossOriginIsolated);"],
        ["/assets/isolation-update.js", "// only in the isolated deployment"],
    ]);
    const asset = (url: string) => {
        const body = files.get(url)!;
        return { url, revision: hash(body), integrity: `sha256-${createHash("sha256").update(body).digest("base64")}` };
    };
    const shared = [
        { url: "/en/", revision: shellRevision },
        asset("/assets/isolation-shell.js"),
        asset("/assets/isolation-worker.js"),
    ];
    const beforeWorker = await buildServiceWorker(shared);
    const afterWorker = await buildServiceWorker([...shared, asset("/assets/isolation-update.js")]);
    let published = beforeWorker;
    let isIsolated = false;
    let isOffline = false;
    let workerScriptDownloads = 0;
    const server = createServer((request, response) => {
        if (isOffline) return response.destroy();
        const path = new URL(request.url!, "http://localhost").pathname;
        response.setHeader("cache-control", "no-store");
        // Hosting sent COOP before isolation too; COEP is what the isolated
        // deployment adds, and what the worker adds to entries cached without it.
        response.setHeader("cross-origin-opener-policy", "same-origin");
        if (isIsolated) response.setHeader("cross-origin-embedder-policy", "require-corp");
        if (path === "/sw.js") {
            response.setHeader("content-type", "text/javascript");
            return response.end(published);
        }
        const body = files.get(path);
        if (body === undefined) {
            response.statusCode = 404;
            return response.end("missing");
        }
        if (path === "/assets/isolation-worker.js") workerScriptDownloads++;
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "text/html");
        response.end(body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let current = page;
    try {
        await current.goto(`${origin}/en/`);
        await current.waitForFunction(() => navigator.serviceWorker.controller !== null);
        const preIsolation = {
            "/en/": "none",
            "/assets/isolation-shell.js": "none",
            "/assets/isolation-worker.js": "none",
        };
        expect(await storedEmbedderPolicies(current)).toEqual(preIsolation);

        published = afterWorker;
        isIsolated = true;
        await current.evaluate(async () => {
            await (await navigator.serviceWorker.getRegistration())!.update();
        });
        await current.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
        // Activation waits for every controlled window to close. A reload
        // would overlap the windows instead.
        const previous = current;
        current = await context.newPage();
        await closeForWorkerActivation(previous, current, origin);

        const navigation = await current.goto(`${origin}/en/`);
        expect(navigation?.fromServiceWorker(), "the updated worker serves the shell").toBe(true);
        // crossOriginIsolated needs both headers on the document: the stored COOP
        // and the COEP the worker adds.
        expect(await isolationOf(current, "/assets/isolation-worker.js")).toEqual({ document: true, worker: true });
        expect(await storedEmbedderPolicies(current), "the update reused the pre-isolation entries").toEqual({
            ...preIsolation,
            "/assets/isolation-update.js": "require-corp",
        });
        expect(workerScriptDownloads, "only the first installation downloaded the worker script").toBe(1);

        // The catch handler serves the cached locale shell for an uncached page.
        isOffline = true;
        await current.goto(`${origin}/en/never-cached/`);
        await expect(current).toHaveTitle("isolation");
        expect(await isolationOf(current, "/assets/isolation-worker.js")).toEqual({ document: true, worker: true });
    } finally {
        await current.goto("about:blank");
        await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
        });
    }
});

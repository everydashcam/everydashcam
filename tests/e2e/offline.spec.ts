// Context routing blocks HTTP, including service-worker fetches, while cached
// declarative resources can still boot the full app. Separate setOffline cases
// cover browser connectivity events and navigation fallback. Chromium can reject
// declarative loads before the worker in that emulation, so those cases assert
// the shell and direct cache fetches outside the strict console-error fixture.

import { expect, test } from "@playwright/test";
import {
    installExportCapture,
    loadTrip,
    masterVideoTime,
    openExport,
    presetLocalStorage,
    readExportResult,
} from "./_fixtures.js";

const READY_TIMEOUT = 20_000;

test.use({ serviceWorkers: "allow" });

// Load /en/ online and wait until OUR service worker controls the page.
// `controller` alone is the sufficient (and strongest) signal: it is set by
// clients.claim() in the activate handler, which the browser runs only after
// the install waitUntil (the precache reconcile) settled - so a controlled
// page implies the shell is fully cached. A fresh context has no prior SW, so
// the controller can only be this test's worker.
//
// The predicate MUST stay synchronous: waitForFunction does not await an async
// predicate - it sees the returned Promise object, which is always truthy, and
// resolves on the first poll. An async predicate here silently turns the gate
// into a no-op, so setOffline() then cuts the network mid-install, kills the
// in-flight precache fetches (holes in the cache), and runs assertions against
// a not-yet-controlled page (every fetch bypasses the SW into the dead
// network) - the exact flake this gate exists to prevent.
async function installServiceWorker(page: import("@playwright/test").Page): Promise<void> {
    await presetLocalStorage(page, { lang: "en" });
    await page.context().route(/^https?:\/\//, async (route) => {
        if (new URL(route.request().url()).origin === "http://localhost:4173") await route.continue();
        else await route.abort();
    });
    await page.goto("/en/");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
        timeout: READY_TIMEOUT,
    });
}

// Run an offline top-level navigation, retrying until the service worker serves
// it. Playwright's offline emulation does not compose reliably with SW
// navigation interception on Chromium (microsoft/playwright#2311): even with the
// worker active and controlling the page, an offline reload/goto can race the
// worker's startup and fall through to the (now-dead) network, throwing
// ERR_INTERNET_DISCONNECTED - though the SW's navigation handler itself always
// returns a Response (worst case the baked-in offline page), so a routed
// navigation never errors. The race is transient: the first navigation warms the
// worker, and the retry routes through it. We retry the navigation IN-test on
// purpose - a Playwright per-test retry would not help, since each retry is a
// fresh context that re-hits the same cold start. A genuinely broken offline
// navigation still fails: every attempt throws until READY_TIMEOUT and toPass
// surfaces the last error - no silent pass.
async function navigateOffline(navigate: () => Promise<unknown>): Promise<void> {
    await expect(navigate).toPass({ timeout: READY_TIMEOUT });
}

test.describe("offline", () => {
    test("boots, ingests local recordings and exports a clip with all network requests blocked", {
        tag: "@golden-offline",
    }, async ({ page, context }) => {
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(err.message));
        await installExportCapture(page);
        await installServiceWorker(page);

        // Context routing reaches SW network fetches without Chromium's
        // setOffline declarative-load interception. No HTTP request can succeed.
        await context.route(/^https?:\/\//, (route) => route.abort("internetdisconnected"));
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "onLine", { get: () => false });
        });
        const response = await page.reload();
        expect(response?.fromServiceWorker(), "navigation is served by the installed worker").toBe(true);
        await expect(page.locator("#offline-banner")).toBeVisible();
        await loadTrip(page);
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        const play = page.locator("#player-play");
        if ((await play.getAttribute("data-paused")) === "false") await play.click();
        const before = await masterVideoTime(page);
        await play.click();
        await expect.poll(() => masterVideoTime(page)).toBeGreaterThan(before + 0.1);
        await play.click();
        await openExport(page);
        const includes = page.locator(".top-panel__channel-include");
        await expect(includes).toHaveCount(3);
        await includes.nth(2).click();
        await includes.nth(1).click();
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 30_000 });
        const result = await readExportResult(page);
        expect(result).not.toBeNull();
        expect(result!.len).toBeGreaterThan(1024);
        expect(result!.ftyp && result!.moov && result!.mdat && result!.gpmd).toBe(true);
        expect(errors).toEqual([]);
    });

    test("opens an unvisited locale route offline despite a different saved language", async ({ page, context }) => {
        await installServiceWorker(page);
        await context.route(/^https?:\/\//, (route) => route.abort("internetdisconnected"));
        const response = await page.goto("/ru/cameras/70mai/?source=offline-test");
        expect(response?.fromServiceWorker()).toBe(true);
        await expect(page.locator("html")).toHaveAttribute("lang", "ru");
        await expect(page.locator("#folder-input")).toBeAttached();
        await loadTrip(page);
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
    });

    test("repairs evicted lazy workers on an online visit without a new deployment", async ({ page }) => {
        await installServiceWorker(page);
        const missingKey = await page.evaluate(async () => {
            const name = (await caches.keys()).find((key) => key.includes("precache"));
            if (!name) return null;
            const cache = await caches.open(name);
            const key = (await cache.keys()).find((request) => /\/assets\/gps-extract-worker-/.test(request.url));
            if (!key) return null;
            await cache.delete(key);
            return key.url;
        });
        expect(missingKey).not.toBeNull();
        await page.reload();
        await expect
            .poll(() => page.evaluate(async (key) => Boolean(await caches.match(key)), missingKey!), {
                timeout: READY_TIMEOUT,
            })
            .toBe(true);
    });

    test("serves the working cached app when the host returns a server error", async ({ page, context }) => {
        await installServiceWorker(page);
        await context.route("**/en/", (route) =>
            route.fulfill({
                status: 503,
                contentType: "text/html",
                body: "<title>service unavailable</title>",
            }),
        );
        const response = await page.reload();
        expect(response?.status()).toBe(200);
        expect(response?.fromServiceWorker()).toBe(true);
        await expect(page.locator("#folder-input")).toBeAttached();
        await expect(page).toHaveTitle(/everydashcam/i);
    });

    test("offline reload serves the cached app shell, not the browser offline page", {
        tag: "@golden-offline",
    }, async ({ page, context }) => {
        await installServiceWorker(page);
        await context.setOffline(true);

        await navigateOffline(() => page.reload());

        // The cached /en/ document is served by the SW. The browser's built-in
        // offline page would carry neither the app title nor #folder-input - so
        // these two assertions distinguish "served from cache" from "you're
        // offline". (JS does not fully boot here only because of the Playwright
        // subresource artifact described in the file header.)
        await expect(page).toHaveTitle(/everydashcam/i);
        await expect(page.locator("#folder-input")).toBeAttached();
    });

    test("offline PWA start_url (/?source=pwa) resolves to a cached locale shell", async ({ page, context }) => {
        await installServiceWorker(page);
        await context.setOffline(true);

        // The manifest's start_url. Offline this must NOT hit the browser error
        // page: the root stub is served (the cache match ignores the query
        // string), its inline JS redirects to /en/, and /en/ is cache-served
        // too (also query-agnostic). The stub goto warms the worker; the
        // client-side redirect to /en/ then routes through the now-warm SW.
        await navigateOffline(() => page.goto("/?source=pwa"));
        await page.waitForURL(/\/en\//, { timeout: READY_TIMEOUT });
        await expect(page.locator("#folder-input")).toBeAttached();
    });

    test("service worker serves the functional offline code graph from cache", async ({ page, context }) => {
        await installServiceWorker(page);

        // The asset URLs the /en/ document declares: entry <script>, every
        // modulepreload chunk and the stylesheet. Fonts deliberately stay out:
        // their unicode-range files cache only when used, and system fonts are
        // the functional offline fallback.
        const declared = await page.evaluate(() => {
            const urls = new Set<string>();
            for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
                urls.add(new URL(s.src).pathname);
            }
            for (const l of document.querySelectorAll<HTMLLinkElement>(
                'link[rel="modulepreload"][href], link[rel="stylesheet"][href]',
            )) {
                urls.add(new URL(l.href).pathname);
            }
            return [...urls].filter((u) => u.startsWith("/assets/"));
        });
        expect(declared.length, "parsed the entry + preloads + css from /en/").toBeGreaterThanOrEqual(2);

        // A worker chunk: proves the offline cache covers ingest (reading an SD
        // card spins up these workers), not just the landing shell.
        const workerChunk = await page.evaluate(async () => {
            const name = (await caches.keys()).find((n) => n.includes("precache"));
            if (!name) return null;
            const keys = await (await caches.open(name)).keys();
            return (
                keys
                    .map((r) => new URL(r.url).pathname)
                    .find((p) => /\/assets\/(ingest|indexer|gps-extract)-worker-/.test(p)) ?? null
            );
        });
        expect(workerChunk, "an ingest worker chunk is precached").not.toBeNull();

        const probe = [...declared, workerChunk as string, "/en/"];
        await context.setOffline(true);

        // Programmatic fetch() from the SW-controlled page routes through the SW
        // fetch handler - the exact code path that serves declarative loads in a
        // real browser. Every boot resource must come back as a cached basic 200.
        const results = await page.evaluate(async (urls) => {
            const out: Record<string, boolean> = {};
            for (const u of urls) {
                try {
                    const r = await fetch(u);
                    out[u] = r.ok && r.type === "basic";
                } catch {
                    out[u] = false;
                }
            }
            return out;
        }, probe);

        for (const [u, ok] of Object.entries(results)) {
            expect(ok, `${u} must be served from the SW cache offline`).toBe(true);
        }
    });

    test("evicted cache but live SW: navigation gets the self-contained fallback, not the browser error", async ({
        page,
        context,
    }) => {
        await installServiceWorker(page);
        // Simulate the Android sub-case where the browser evicts Cache Storage
        // but the SW registration survives: wipe every cache, keep the worker.
        await page.evaluate(async () => {
            for (const k of await caches.keys()) await caches.delete(k);
        });
        await context.setOffline(true);

        await navigateOffline(() => page.goto("/en/"));
        // The SW served its baked-in fallback (no external refs), so the page
        // renders our retry UI rather than the browser's offline page.
        await expect(page.locator("#dc-r")).toBeVisible();
        await expect(page.locator("#dc-t")).toHaveText(/offline/i);
    });

    test("offline banner shows when connectivity drops and clears when it returns", async ({ page, context }) => {
        // Load online first so the app boots fully (this avoids the offline-reload
        // subresource artifact in the file header - the page JS is already
        // running, and setOffline just fires the 'offline' event into it).
        await installServiceWorker(page);
        const banner = page.locator("#offline-banner");
        await expect(banner).toBeHidden();

        await context.setOffline(true);
        await expect(banner).toBeVisible();
        await expect(page.locator(".offline-banner-label")).toHaveText(/offline/i);
        // The body class exposes effective connectivity state to shell styling.
        await expect(page.locator("body")).toHaveClass(/has-offline-banner/);

        // Info button toggles the detail popover.
        const popover = page.locator("#offline-banner-popover");
        await expect(popover).toBeHidden();
        await page.locator("#offline-banner-info").click();
        await expect(popover).toBeVisible();

        await context.setOffline(false);
        await expect(banner).toBeHidden();
        await expect(page.locator("body")).not.toHaveClass(/has-offline-banner/);
    });
});

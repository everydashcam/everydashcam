import { type Page, type Route } from "@playwright/test";

import { expect, gotoApp, loadTrip, presetLocalStorage, test } from "./_fixtures.js";

test.use({ serviceWorkers: "block" });

async function expectLocalTrack(page: Page, hasPendingBasemap = false): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate((pending) => {
                const { map, miniMap } = window.__everydashcam.state;
                return Boolean(
                    map?.getSource("openmaptiles") &&
                        map.getLayer("trip-line") &&
                        miniMap?.getLayer("trip-line") &&
                        (!pending || !map.isStyleLoaded()),
                );
            }, hasPendingBasemap),
        )
        .toBe(true);
}

test("draws the local track while remote map bootstrap remains pending, including a theme swap", {
    tag: ["@golden-map", "@golden-offline"],
}, async ({ page }) => {
    const heldRequests: Route[] = [];
    await page.route("https://tiles.openfreemap.org/planet", (route) => {
        heldRequests.push(route);
    });
    await presetLocalStorage(page);
    await gotoApp(page);
    await loadTrip(page);

    await expect.poll(() => heldRequests.length).toBeGreaterThan(0);
    await expectLocalTrack(page, true);
    await page.locator('.theme-toggle-btn[data-theme="light"]').click();
    await expect(page.locator("html")).toHaveClass(/dc-light/);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const layer = window.__everydashcam.state.map
                    ?.getStyle()
                    ?.layers.find((layer) => layer.type === "background");
                return layer?.paint?.["background-color"];
            }),
        )
        .toBe("#f5f4ef");
    await expectLocalTrack(page, true);

    await page.unroute("https://tiles.openfreemap.org/planet");
    await Promise.all(heldRequests.map((route) => route.abort()));
});

for (const hasOnlineEvent of [true, false]) {
    const recoveryTest = test.extend({
        // The injected browser disconnect can fail an in-flight local asset request.
        tolerateConsole: hasOnlineEvent ? [/^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/] : [],
    });
    const recovery = hasOnlineEvent ? "when the browser reconnects" : "when the WAN returns without an online event";
    recoveryTest(`retries a failed map bootstrap ${recovery}`, async ({ page, context }) => {
        if (!hasOnlineEvent) await page.clock.install();
        let canLoadTiles = false;
        let bootstrapRequests = 0;
        await page.route("https://tiles.openfreemap.org/**", async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === "/planet") bootstrapRequests++;
            if (!canLoadTiles) {
                await route.abort();
                return;
            }
            if (url.pathname === "/planet") {
                await route.fulfill({
                    json: {
                        tilejson: "3.0.0",
                        tiles: ["https://tiles.openfreemap.org/planet/offline-test/{z}/{x}/{y}.pbf"],
                        minzoom: 0,
                        maxzoom: 14,
                    },
                    headers: { "access-control-allow-origin": "*" },
                });
            } else if (url.pathname.endsWith(".pbf")) {
                // An empty protobuf is a valid vector tile with no features.
                await route.fulfill({
                    body: Buffer.alloc(0),
                    contentType: "application/x-protobuf",
                    headers: { "access-control-allow-origin": "*" },
                });
            } else {
                // Missing optional raster/glyph resources are HTTP failures,
                // so they cannot masquerade as another loss of connectivity.
                await route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } });
            }
        });
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await expect(page.locator("#offline-banner")).toBeVisible();
        await expectLocalTrack(page);
        // The closing ingest regroup fits the track again, even after the
        // analysis indicator clears. Set the recovery camera only after it.
        await expect
            .poll(() =>
                page.evaluate(() =>
                    window.__everydashcam.dumpLog().some((entry) => entry.msg === "recording metadata complete"),
                ),
            )
            .toBe(true);
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);
        const requestsBeforeRecovery = bootstrapRequests;
        expect(requestsBeforeRecovery, "the map bootstrap failed before recovery").toBeGreaterThan(0);
        await page.evaluate(() => {
            window.__everydashcam.state.followMode = "off";
            window.__everydashcam.state.map?.jumpTo({ center: [65, 45], zoom: 9, bearing: 20 });
        });

        if (hasOnlineEvent) await context.setOffline(true);
        canLoadTiles = true;
        if (hasOnlineEvent) await context.setOffline(false);
        // Exercise the scheduled retry while the browser remains online.
        else await page.clock.fastForward(15_000);

        await expect.poll(() => bootstrapRequests).toBeGreaterThan(requestsBeforeRecovery);
        await expect(page.locator("#offline-banner")).toBeHidden();
        await expectLocalTrack(page);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getCenter().lng)).toBeCloseTo(65);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getCenter().lat)).toBeCloseTo(45);
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    });
}

test.describe("map style failures", () => {
    test.use({
        tolerateConsole: [
            [
                /Failed to load resource: the server responded with a status of 503/,
                // The reconnect case deliberately takes the browser offline; an
                // in-flight asset request can report that injected network failure.
                /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
            ],
            { scope: "test" },
        ],
    });

    test("promotes a prefetched style request when the foreground map joins it", async ({ page }) => {
        let prefetched: Route | undefined;
        await page.route("**/styles/light.json", (route) => {
            prefetched = route;
        });
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await expectLocalTrack(page);
        await expect.poll(() => Boolean(prefetched)).toBe(true);
        await page.locator('.theme-toggle-btn[data-theme="light"]').click();
        if (!prefetched) throw new Error("style prefetch is missing");
        await prefetched.fulfill({ status: 503 });

        await expect(page.locator("#map-style-error")).toHaveJSProperty("hidden", false);
        const failureSource = await page.evaluate(
            () =>
                window.__everydashcam
                    .dumpLog()
                    .find((entry) => entry.msg === "map style fetch failed" && entry.ctx?.theme === "light")?.ctx
                    ?.source,
        );
        expect(failureSource).toBe("main");
    });

    for (const replacement of ["provider", "theme"] as const) {
        test(`ignores a pending style failure after the map ${replacement} changes`, async ({ page }) => {
            let pendingStyle: Route | undefined;
            await page.route("**/styles/dark.json", (route) => {
                pendingStyle = route;
            });
            await presetLocalStorage(page);
            await gotoApp(page);
            await loadTrip(page);
            await expect.poll(() => Boolean(pendingStyle)).toBe(true);
            await page.locator("#settings-btn").click();
            if (replacement === "provider") {
                await page.locator("#settings-map-provider-select").selectOption("osm-vector");
                await expect
                    .poll(() =>
                        page.evaluate(() => Boolean(window.__everydashcam.state.map?.getSource("osm-shortbread"))),
                    )
                    .toBe(true);
            } else {
                await page.locator("#settings-map-theme-select").selectOption("light");
                await expectLocalTrack(page);
            }
            if (!pendingStyle) throw new Error("style request is missing");
            await pendingStyle.fulfill({ status: 503 });
            await expect
                .poll(() =>
                    page.evaluate(() =>
                        window.__everydashcam.dumpLog().some((entry) => entry.msg === "map style fetch failed"),
                    ),
                )
                .toBe(true);
            await expect(page.locator("#map-style-error")).toHaveJSProperty("hidden", true);
            await expect
                .poll(() => page.evaluate(() => Boolean(window.__everydashcam.state.map?.getLayer("trip-line"))))
                .toBe(true);
        });
    }

    test("keeps the selected theme failure visible when an old theme finishes loading", async ({ page }) => {
        let pendingStyle: Route | undefined;
        await page.route("**/styles/dark.json", (route) => {
            pendingStyle = route;
        });
        await page.route("**/styles/light.json", (route) => route.fulfill({ status: 503 }));
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await expect.poll(() => Boolean(pendingStyle)).toBe(true);
        await page.locator("#settings-btn").click();
        await page.locator("#settings-map-theme-select").selectOption("light");
        await expect(page.locator("#map-style-error")).toHaveJSProperty("hidden", false);

        if (!pendingStyle) throw new Error("style request is missing");
        await pendingStyle.fallback();
        await expect
            .poll(() =>
                page.evaluate(() =>
                    window.__everydashcam
                        .dumpLog()
                        .some((entry) => entry.msg === "map style loaded" && entry.ctx?.theme === "dark"),
                ),
            )
            .toBe(true);
        await expect(page.locator("#map-style-error")).toHaveJSProperty("hidden", false);
    });

    test("retries the initial style on reconnect before any map tile has been requested", async ({ page, context }) => {
        let canLoadStyle = false;
        let bootstrapRequests = 0;
        page.on("request", (request) => {
            if (request.url() === "https://tiles.openfreemap.org/planet") bootstrapRequests++;
        });
        await page.route("**/styles/*.json", async (route) => {
            if (canLoadStyle) await route.fallback();
            else await route.fulfill({ status: 503 });
        });
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await expect(page.locator("#map-style-error")).toHaveJSProperty("hidden", false);
        await expect
            .poll(() => page.evaluate(() => Boolean(window.__everydashcam.state.map?.getLayer("trip-line"))))
            .toBe(true);
        expect(bootstrapRequests).toBe(0);

        await context.setOffline(true);
        canLoadStyle = true;
        await context.setOffline(false);

        await expectLocalTrack(page);
        await expect(page.locator("#map-style-error")).toHaveJSProperty("hidden", true);
        expect(bootstrapRequests).toBeGreaterThan(0);
    });
});

for (const fault of ["http", "json"] as const) {
    test(`recovers from a temporary ${fault === "http" ? "503 response" : "invalid TileJSON response"} without reloading the page`, async ({
        page,
    }) => {
        await page.clock.install();
        let canLoadTiles = false;
        let bootstrapRequests = 0;
        await page.route(/openfreemap\.org|(?:tile|vector)\.openstreetmap\.org/i, async (route) => {
            const url = new URL(route.request().url());
            if (url.hostname !== "tiles.openfreemap.org") {
                await route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" } });
                return;
            }
            if (url.pathname === "/planet") {
                bootstrapRequests++;
                if (!canLoadTiles) {
                    await route.fulfill({
                        status: fault === "http" ? 503 : 200,
                        body: "<html>temporarily unavailable</html>",
                        headers: { "access-control-allow-origin": "*" },
                    });
                    return;
                }
                await route.fulfill({
                    json: {
                        tilejson: "3.0.0",
                        tiles: ["https://tiles.openfreemap.org/recovery-test/{z}/{x}/{y}.pbf"],
                        minzoom: 0,
                        maxzoom: 14,
                    },
                    headers: { "access-control-allow-origin": "*" },
                });
            } else if (url.pathname.endsWith(".pbf") && canLoadTiles) {
                await route.fulfill({ body: Buffer.alloc(0), headers: { "access-control-allow-origin": "*" } });
            } else {
                await route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } });
            }
        });
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await expectLocalTrack(page);
        await expect(page.locator("#offline-banner")).toBeVisible();
        const requestsBeforeRecovery = bootstrapRequests;
        expect(requestsBeforeRecovery, "the invalid response was requested before recovery").toBeGreaterThan(0);
        canLoadTiles = true;
        await page.clock.fastForward(15_000);
        await expect.poll(() => bootstrapRequests).toBeGreaterThan(requestsBeforeRecovery);
        await expect(page.locator("#offline-banner")).toBeHidden();
        await expectLocalTrack(page);
    });
}

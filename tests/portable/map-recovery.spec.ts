import { type Page, expect } from "@playwright/test";
import {
    loadTrip,
    masterVideoTime,
    openExport,
    pausePlayback,
    presetLocalStorage,
    SAMPLE_70MAI,
} from "../e2e/_fixtures.js";
import { expectLocalRoute, isPortableMapRequest, openPortable, test, TEST_MAP_TILE } from "./_fixtures.js";

async function selectViewerMap(page: Page, provider: string): Promise<void> {
    await page.locator("#settings-btn").click();
    await page.locator("#settings-map-provider-select").selectOption(provider);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("everydashcam:mapProvider"))).toBe(provider);
    await page.locator("#settings-modal-header-close").click();
}

test("keeps the local route stable after every online provider fails and restores tiles on reconnection", async ({
    page,
    requests,
}, info) => {
    let canLoadRaster = false;
    await page.route("https://tile.openstreetmap.org/**", (route) =>
        canLoadRaster
            ? route.fulfill({
                  body: TEST_MAP_TILE,
                  contentType: "image/png",
                  headers: { "access-control-allow-origin": "*" },
              })
            : route.abort(),
    );
    await page.clock.install();
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("map-recovery"));
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("openfreemap");
    expect(requests.filter(isPortableMapRequest), "the landing has no active map").toEqual([]);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await expectLocalRoute(page);
    for (const host of ["tiles.openfreemap.org", "vector.openstreetmap.org", "tile.openstreetmap.org"]) {
        expect(
            requests.some((url) => new URL(url).hostname === host),
            `${host} is attempted before local fallback`,
        ).toBe(true);
    }
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("openfreemap");
    await page.evaluate(() => {
        document.documentElement.dataset.mapStyleReloads = "0";
        for (const map of [window.__everydashcam.state.map, window.__everydashcam.state.miniMap]) {
            map?.on("style.load", () => {
                const root = document.documentElement;
                root.dataset.mapStyleReloads = String(Number(root.dataset.mapStyleReloads) + 1);
            });
        }
    });
    const beforeRetry = requests.filter(isPortableMapRequest).length;
    const failedProbe = page.waitForEvent("requestfailed", {
        predicate: (request) => new URL(request.url()).hostname === "tile.openstreetmap.org",
    });
    await page.clock.fastForward(20_000);
    await failedProbe;
    await expect.poll(() => requests.filter(isPortableMapRequest).length).toBeGreaterThan(beforeRetry);
    await expectLocalRoute(page);
    await expect(page.locator("html")).toHaveAttribute("data-map-style-reloads", "0");

    await page.route("https://tiles.openfreemap.org/planet", (route) =>
        route.fulfill({
            body: "<html>upstream unavailable</html>",
            contentType: "text/html",
            headers: { "access-control-allow-origin": "*" },
        }),
    );
    const invalidBootstrapProbe = page.waitForEvent("requestfailed", {
        predicate: (request) => new URL(request.url()).hostname === "tile.openstreetmap.org",
    });
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await invalidBootstrapProbe;
    await expectLocalRoute(page);
    await expect(page.locator("html")).toHaveAttribute("data-map-style-reloads", "0");

    const playbackBefore = await masterVideoTime(page);
    await page.locator("#player-play").click();
    await expect.poll(() => masterVideoTime(page)).toBeGreaterThan(playbackBefore + 0.1);
    await pausePlayback(page);
    await expect(page.locator("html")).toHaveAttribute("data-map-style-reloads", "0");

    canLoadRaster = true;
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.miniMap;
                return Boolean(
                    map?.getSource("osm-raster") &&
                        map.isStyleLoaded() &&
                        map.isSourceLoaded("osm-raster") &&
                        map.getLayer("trip-line"),
                );
            }),
        )
        .toBe(true);
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("openfreemap");
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
});

test("persists explicit route-only mode without tile requests or reconnect probes", async ({
    page,
    requests,
}, info) => {
    await page.clock.install();
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("explicit-local-map"));
    await selectViewerMap(page, "route-only");
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await expectLocalRoute(page);
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await page.clock.fastForward(20_000);
    await expectLocalRoute(page);
    expect(requests.filter(isPortableMapRequest)).toEqual([]);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("everydashcam:mapProvider"))).toBe("route-only");

    await page.clock.resume();
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:mapProvider"))).toBe("route-only");
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("route-only");
    await loadTrip(page, SAMPLE_70MAI);
    await expectLocalRoute(page);
    expect(requests.filter(isPortableMapRequest)).toEqual([]);
});

test("restores the saved export map choice without changing the viewer preference", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("export-map-preference"));
    await selectViewerMap(page, "route-only");
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await openExport(page);
    await page.locator("#export-panel-ov-map").check();
    await expect(page.locator("#export-map-provider-select")).toHaveValue("openfreemap");
    await page.locator("#export-map-provider-select").selectOption("osm-vector");
    await expect(page.locator("#player-map-overlay-canvas")).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("route-only");
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await openExport(page);
    await expect(page.locator("#export-panel-ov-map")).toBeChecked();
    await page.locator("#export-panel-map-overlay-row").getByRole("button", { name: "Map", exact: true }).click();
    await expect(page.locator("#export-map-provider-select")).toHaveValue("osm-vector");
    await expect(page.locator("#player-map-overlay-canvas")).toBeVisible();
});

import type { GeoJSONSource } from "maplibre-gl";
import { DESKTOP, expect, gotoApp, loadTrip, presetLocalStorage, test } from "./_fixtures.js";

test.use({ serviceWorkers: "block" });

for (const { restoreOrder, changeTheme } of [
    { restoreOrder: ["map", "miniMap"], changeTheme: false },
    { restoreOrder: ["miniMap", "map"], changeTheme: false },
    { restoreOrder: ["miniMap"], changeTheme: false },
    { restoreOrder: ["map", "miniMap"], changeTheme: true },
] as const) {
    test(`regroups during WebGL loss and restores ${restoreOrder.join(" then ")}${changeTheme ? " with a new theme" : ""}`, async ({
        page,
    }) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const { map, miniMap } = window.__everydashcam.state;
                    return Boolean(map?.getLayer("trip-line") && miniMap?.getLayer("trip-line"));
                }),
            )
            .toBe(true);
        await page.locator("#settings-btn").click();
        const contexts = await page.evaluateHandle(async (surfaces) => {
            window.__everydashcam.dom.player.pause();
            const contexts = new Map<string, WEBGL_lose_context>();
            await Promise.all(
                surfaces.map(async (surface) => {
                    const map = window.__everydashcam.state[surface]!;
                    const extension = map.getCanvas().getContext("webgl2")?.getExtension("WEBGL_lose_context");
                    if (!extension) throw new Error("context loss extension is missing");
                    contexts.set(surface, extension);
                    const lost = map.once("webglcontextlost");
                    extension.loseContext();
                    await lost;
                }),
            );
            return contexts;
        }, restoreOrder);

        if (changeTheme) {
            await page.locator("#settings-map-theme-select").selectOption("light");
            await expect(page.locator("#settings-map-theme-select")).toHaveValue("light");
        }

        // Exercise the same settings callback as a regroup with a lost GPU.
        await page.locator("label:has(#settings-trip-gap-never)").click();
        await expect(page.locator("#settings-trip-gap-never")).toBeChecked();
        expect(
            await page.evaluate(
                (surfaces) =>
                    surfaces.every((surface) => {
                        const state = window.__everydashcam.state;
                        return !state[surface === "map" ? "mapReady" : "miniMapReady"] && !state[surface]?.getStyle();
                    }),
                restoreOrder,
            ),
        ).toBe(true);

        for (const surface of restoreOrder) {
            await contexts.evaluate(async (contexts, surface) => {
                const map = window.__everydashcam.state[surface]!;
                const loaded = map.once("style.load");
                contexts.get(surface)!.restoreContext();
                await loaded;
            }, surface);
        }
        await contexts.dispose();
        if (changeTheme) {
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const { map, miniMap } = window.__everydashcam.state;
                        return [map, miniMap].every(
                            (map) => map?.getPaintProperty("background", "background-color") === "#f5f4ef",
                        );
                    }),
                )
                .toBe(true);
        }
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const { map, miniMap, mapReady, miniMapReady } = window.__everydashcam.state;
                    return (
                        mapReady &&
                        miniMapReady &&
                        [map, miniMap].every((map) =>
                            ["trip-line", "trip-line-outline", "trip-line-halo"].every((id) =>
                                Boolean(map?.getLayer(id)),
                            ),
                        )
                    );
                }),
            )
            .toBe(true);
        for (const selector of ["#map", "#mini-map"]) {
            await expect(page.locator(`${selector} .endpoint-marker-wrap`)).toHaveCount(2);
            await expect(page.locator(`${selector} .car-marker-wrap`)).toHaveCount(1);
        }
        // A subsequent regroup must also leave a single working track.
        await page.locator("label:has(#settings-trip-gap-never)").click();
        await expect(page.locator("#settings-trip-gap-never")).not.toBeChecked();
        expect(
            await page.evaluate(() => {
                const { map, miniMap } = window.__everydashcam.state;
                return Boolean(map?.getLayer("trip-line") && miniMap?.getLayer("trip-line"));
            }),
        ).toBe(true);
    });
}

test("completes the saved chase tilt when the basemap interrupts initial entry", async ({ page }) => {
    await presetLocalStorage(page);
    await page.addInitScript(() =>
        localStorage.setItem("dc.viewer.panels", JSON.stringify({ map: true, mapMode: "large" })),
    );
    await page.route("**/styles/**/dark.json", async (route) => {
        await page.waitForFunction(() => (window.__everydashcam.state.map?.getPitch() ?? 0) > 5);
        await route.fallback();
    });
    await gotoApp(page);
    await loadTrip(page);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getPitch() ?? 0)).toBeCloseTo(58, 1);
});

test("starts and responds to theme controls when storage access is denied", async ({ page }) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
            get() {
                throw new DOMException("storage denied", "SecurityError");
            },
        });
    });
    await gotoApp(page);
    await expect.poll(() => page.evaluate(() => Boolean(window.__everydashcam))).toBe(true);
    await page.locator('.theme-toggle-btn[data-theme="light"]').click();
    await expect(page.locator("html")).toHaveClass(/dc-light/);
});

test("keeps a paused inspection view when map preferences change during chase", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await page.locator("#mini-map").click();
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getPitch() ?? 0)).toBeCloseTo(58, 1);
    await page.evaluate(() => {
        const { state, dom } = window.__everydashcam;
        dom.player.pause();
        const map = state.map!;
        map.fire("dragstart", { originalEvent: new MouseEvent("mousedown") });
        map.jumpTo({ center: [20, 50], zoom: 14.8, bearing: 70, pitch: 30 });
        map.fire("dragend", { originalEvent: new MouseEvent("mouseup") });
    });
    await page.locator("#map-settings-toggle").click();
    await page.locator("#map-style-select").selectOption("road");
    await page.locator("#map-theme-select").selectOption("light");
    await page.locator("#map-style-select").selectOption("minimal");
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.map!;
                return (
                    Boolean(map.getLayer("trip-line")) &&
                    map.getPaintProperty("background", "background-color") === "#f5f4ef" &&
                    !map.getLayer("park")
                );
            }),
        )
        .toBe(true);
    const view = await page.evaluate(() => {
        const { state, dom } = window.__everydashcam;
        const map = state.map!;
        return {
            lng: map.getCenter().lng,
            lat: map.getCenter().lat,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
            mode: state.followMode,
            paused: dom.player.paused,
        };
    });
    expect(view.lng).toBeCloseTo(20);
    expect(view.lat).toBeCloseTo(50);
    expect(view.zoom).toBeCloseTo(14.8);
    expect(view.bearing).toBeCloseTo(70);
    expect(view.pitch).toBeCloseTo(30);
    expect(view.mode).toBe("chase");
    expect(view.paused).toBe(true);
});

test("raster providers keep the viewer flat and north-up", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await page.locator("#mini-map").click();
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getPitch() ?? 0)).toBeGreaterThan(20);

    await page.evaluate(() => window.__everydashcam.setMapProvider("osm-raster"));
    const rotate = page.locator('.map-follow-seg[data-follow-mode="rotate"]');
    const chase = page.locator('.map-follow-seg[data-follow-mode="chase"]');
    await expect(rotate).toBeDisabled();
    await expect(chase).toBeDisabled();
    await expect(page.locator("#map-chase-controls")).toBeHidden();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { state } = window.__everydashcam;
                return {
                    mode: state.followMode,
                    bearing: state.map?.getBearing(),
                    pitch: state.map?.getPitch(),
                    maxPitch: state.map?.getMaxPitch(),
                    canDragRotate: state.map?.dragRotate.isEnabled(),
                };
            }),
        )
        .toEqual({ mode: "follow", bearing: 0, pitch: 0, maxPitch: 0, canDragRotate: false });

    await page.locator('.map-follow-seg[data-follow-mode="off"]').click();
    const compass = await page.locator("#map .maplibregl-ctrl-compass").boundingBox();
    if (!compass) throw new Error("map compass is missing");
    await page.mouse.move(compass.x + compass.width / 2, compass.y + 4);
    await page.mouse.down();
    await page.mouse.move(compass.x + 70, compass.y + compass.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.locator("#map .maplibregl-canvas").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowUp");
    expect(await page.evaluate(() => window.__everydashcam.state.map!.getBearing())).toBe(0);
    expect(await page.evaluate(() => window.__everydashcam.state.map!.getPitch())).toBe(0);
    await page.evaluate(() => window.__everydashcam.state.map!.jumpTo({ bearing: 90, pitch: 40 }));
    expect(await page.evaluate(() => window.__everydashcam.state.map!.getBearing())).toBe(0);
    expect(await page.evaluate(() => window.__everydashcam.state.map!.getPitch())).toBe(0);
    await expect(page.locator("#settings-map-label-scale-select")).toBeDisabled();
    await expect(page.locator("#map-buildings3d-toggle")).toBeDisabled();

    await page.evaluate(() => window.__everydashcam.setMapProvider("osm-vector"));
    await expect(rotate).toBeEnabled();
    await expect(chase).toBeEnabled();
    await expect(page.locator("#settings-map-label-scale-select")).toBeEnabled();
    await chase.click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getPitch() ?? 0)).toBeGreaterThan(20);
});

test("keeps a crossing route and follow camera near the antimeridian", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await page.locator("#mini-map").click();
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await page.locator('.map-follow-seg[data-follow-mode="off"]').click();
    await page.evaluate(() => {
        const { state, dom, setMapProvider } = window.__everydashcam;
        dom.player.pause();
        const trip = state.trips[state.active!.trip]!;
        const startUtc = trip.frames[state.active!.frame]!.startUtc;
        const record = trip.records.find((r) => r.active)!;
        trip.records = [179.99, -179.99, -179.98].map((lon, i) => ({
            ...record,
            unixSeconds: startUtc + i,
            lat: 50,
            lon,
        }));
        setMapProvider("osm-raster");
    });
    await expect
        .poll(async () =>
            page.evaluate(async () => {
                const source = window.__everydashcam.state.map?.getSource("trip-line") as GeoJSONSource | undefined;
                if (!source) return false;
                const data = await source.getData();
                return (
                    data.type === "Feature" &&
                    data.geometry.type === "LineString" &&
                    data.geometry.coordinates[1]![0]! > 180
                );
            }),
        )
        .toBe(true);
    expect(Math.abs(await page.evaluate(() => window.__everydashcam.state.map!.getCenter().lng))).toBeGreaterThan(179);
    await page.locator('.map-follow-seg[data-follow-mode="follow"]').click();
    for (const [time, expectedLon] of [
        [0.5, 180],
        [1.5, 180.015],
    ] as const) {
        await page.evaluate((time) => {
            window.__everydashcam.dom.player.currentTime = time;
        }, time);
        await expect
            .poll(() =>
                page.evaluate((lon) => {
                    const actual = window.__everydashcam.state.marker!.getLngLat().lng;
                    return ((actual - lon + 540) % 360) - 180;
                }, expectedLon),
            )
            .toBeCloseTo(0, 4);
        await expect
            .poll(() =>
                page.evaluate((lon) => {
                    const actual = window.__everydashcam.state.map!.getCenter().lng;
                    return ((actual - lon + 540) % 360) - 180;
                }, expectedLon),
            )
            .toBeCloseTo(0, 3);
    }
});

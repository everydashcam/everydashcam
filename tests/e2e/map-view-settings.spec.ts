import type { Locator, Page } from "@playwright/test";

import {
    DESKTOP,
    MOBILE,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

function mapBackground(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
        const layer = window.__everydashcam.state.map?.getStyle()?.layers.find((layer) => layer.type === "background");
        return JSON.stringify(layer?.paint?.["background-color"]);
    });
}

function markerPixels(canvas: Locator): Promise<string | null> {
    return canvas.evaluate((element: HTMLCanvasElement) => {
        const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
        const hasPaint = pixels.some((value, index) => index % 4 === 3 && value > 0);
        return hasPaint ? element.toDataURL() : null;
    });
}

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
});

test("vehicle markers use overhead art on flat maps and preserve the chase perspective", async ({ page }) => {
    await loadTrip(page);
    await pausePlayback(page);
    const miniMarker = page.locator("#mini-map .car-marker__canvas");
    const mainMarker = page.locator(".map-wrap .car-marker__canvas");
    await expect(miniMarker).toHaveAttribute("data-marker-render-key", "arrow:#ff9000");
    await expect.poll(() => markerPixels(miniMarker)).toBeTruthy();
    const arrowPixels = await markerPixels(miniMarker);

    await page.locator("#settings-btn").click();
    const settings = page.locator('[data-marker-control="settings"]');
    await settings.locator('button[data-marker-shape="sedan"]').click();
    const preview = settings.locator('button[data-marker-shape="sedan"] canvas');
    await expect.poll(() => markerPixels(preview)).toBeTruthy();
    const perspectivePixels = await markerPixels(preview);
    await page.locator("#settings-modal-header-close").click();
    await expect(miniMarker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000:overhead");
    await expect.poll(() => markerPixels(miniMarker)).not.toBe(arrowPixels);
    const overheadPixels = await markerPixels(miniMarker);
    expect(overheadPixels, "the overhead vehicle is visibly painted").toBeTruthy();
    expect(overheadPixels, "flat maps use different vehicle artwork from the chase preview").not.toBe(
        perspectivePixels,
    );

    await page.locator("#mini-map").click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map!.getPitch())).toBeGreaterThan(20);
    await expect(mainMarker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000");
    await expect.poll(() => markerPixels(mainMarker)).toBe(perspectivePixels);

    await page.locator('.map-follow-seg[data-follow-mode="follow"]').click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map!.getPitch())).toBeLessThan(1);
    await expect
        .poll(() => page.evaluate(() => Math.abs(window.__everydashcam.state.map!.getBearing())))
        .toBeLessThan(1);
    await expect(mainMarker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000:overhead");
    await expect.poll(() => markerPixels(mainMarker)).toBe(overheadPixels);
    await page.locator('.map-follow-seg[data-follow-mode="rotate"]').click();
    await expect(mainMarker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000:overhead");
    await expect.poll(() => markerPixels(mainMarker)).toBe(overheadPixels);

    await page.locator('.map-follow-seg[data-follow-mode="chase"]').click();
    await expect(mainMarker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000");
    await expect.poll(() => markerPixels(mainMarker)).toBe(perspectivePixels);
    await page.locator('.map-follow-seg[data-follow-mode="follow"]').click();
    await expect(mainMarker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000:overhead");
    await expect.poll(() => markerPixels(mainMarker)).toBe(overheadPixels);
    await page.locator("#map-settings-toggle").click();
    const popover = page.locator('[data-marker-control="map-popover"]');
    await popover.locator('button[data-marker-color="#e5484d"]').click();
    await popover.locator('button[data-marker-size="large"]').click();
    await expect(mainMarker).toHaveAttribute("data-marker-render-key", "sedan:#e5484d:overhead");
    await expect(miniMarker).toHaveAttribute("data-marker-render-key", "sedan:#e5484d:overhead");
    await expect.poll(() => markerPixels(mainMarker)).not.toBe(overheadPixels);
    const redOverheadPixels = await markerPixels(mainMarker);
    expect(redOverheadPixels).toBeTruthy();
    await expect.poll(() => markerPixels(miniMarker)).toBe(redOverheadPixels);
    await expect(mainMarker).toHaveCSS("width", "52px");
    const redPreview = popover.locator('button[data-marker-shape="sedan"] canvas');
    await expect(redPreview).toHaveAttribute("data-marker-render-key", "sedan:#e5484d");
    await expect.poll(() => markerPixels(redPreview)).not.toBe(perspectivePixels);
    const redPerspectivePixels = await markerPixels(redPreview);
    await page.keyboard.press("Escape");
    await page.locator('.map-follow-seg[data-follow-mode="chase"]').click();
    await expect.poll(() => markerPixels(mainMarker)).toBe(redPerspectivePixels);
    expect(redPerspectivePixels).not.toBe(redOverheadPixels);
    await page.locator("#map-collapse").click();
    await expect(miniMarker).toBeVisible();
    await expect.poll(() => markerPixels(miniMarker)).toBe(redOverheadPixels);
});

for (const locale of ["en", "ru"] as const) {
    test(`the north compass only resets bearing on a flat map (${locale})`, async ({ page }) => {
        if (locale !== "en") await gotoApp(page, locale);
        await loadTrip(page);
        await pausePlayback(page);
        await page.locator("#mini-map").click();
        await page.locator("#map-settings-toggle").click();
        await page.locator('[data-marker-control="map-popover"] button[data-marker-shape="sedan"]').click();
        const preview = page.locator('[data-marker-control="map-popover"] button[data-marker-shape="sedan"] canvas');
        await expect.poll(() => markerPixels(preview)).toBeTruthy();
        const chasePixels = await markerPixels(preview);
        await page.keyboard.press("Escape");
        const compass = page.locator(".map-wrap .maplibregl-ctrl-compass");
        const marker = page.locator(".map-wrap .car-marker__canvas");
        await expect(marker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000");
        await expect.poll(() => markerPixels(marker)).toBe(chasePixels);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map!.isMoving())).toBe(false);

        const disabledCompassKeepsCamera = async (): Promise<void> => {
            await expect(compass).toBeDisabled();
            await expect(compass).toHaveAccessibleName(
                locale === "en" ? "North up is available in flat view" : "Север сверху доступен в плоском режиме",
            );
            // Follow uses per-frame jumpTo calls that can run while isMoving() is false.
            // Observe only the click handler's effects, without a follow frame in between.
            const { before, after } = await compass.evaluate((button) => {
                const map = window.__everydashcam.state.map!;
                const before = { bearing: map.getBearing(), pitch: map.getPitch() };
                button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                const after = { bearing: map.getBearing(), pitch: map.getPitch(), moving: map.isMoving() };
                return { before, after };
            });
            expect(after.bearing, "a disabled compass preserves the camera bearing").toBeCloseTo(before.bearing);
            expect(after.pitch, "a disabled compass preserves the camera tilt").toBeCloseTo(before.pitch);
            expect(after.moving, "a disabled compass does not start a camera animation").toBe(false);
        };

        await page.evaluate(() => window.__everydashcam.state.map!.jumpTo({ bearing: 45 }));
        await disabledCompassKeepsCamera();
        await page.locator('.map-follow-seg[data-follow-mode="follow"]').click();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map!.getPitch())).toBeLessThan(1);
        await expect(compass).toBeEnabled();
        await page.locator('.map-follow-seg[data-follow-mode="off"]').click();
        await page.evaluate(() => window.__everydashcam.state.map!.jumpTo({ bearing: 45, pitch: 0 }));
        await compass.click();
        await expect
            .poll(() => page.evaluate(() => Math.abs(window.__everydashcam.state.map!.getBearing())))
            .toBeLessThan(0.1);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map!.isMoving())).toBe(false);

        await page.evaluate(() => window.__everydashcam.state.map!.jumpTo({ bearing: 60, pitch: 50 }));
        await disabledCompassKeepsCamera();
        await page.locator('.map-follow-seg[data-follow-mode="chase"]').click();
        await expect(compass).toBeDisabled();
        await expect(marker).toHaveAttribute("data-marker-render-key", "sedan:#ff9000");
        await expect.poll(() => markerPixels(marker)).toBe(chasePixels);
    });
}

test.describe("delayed marker assets", () => {
    // Service-worker precaching would bypass the response gate in page.route.
    test.use({ serviceWorkers: "block" });

    test("a late overhead sprite cannot overwrite a marker after returning to chase", async ({ page }) => {
        await loadTrip(page);
        await pausePlayback(page);
        const mainMarker = page.locator(".map-wrap .car-marker__canvas");
        const miniMarker = page.locator("#mini-map .car-marker__canvas");
        await expect.poll(() => markerPixels(miniMarker)).toBeTruthy();
        const arrowPixels = await markerPixels(miniMarker);
        let releaseSprite = (): void => {};
        const spriteGate = new Promise<void>((resolve) => {
            releaseSprite = resolve;
        });
        let spriteRequested = false;
        await page.route(/\/suv-overhead[^/]*\.webp(?:\?.*)?$/, async (route) => {
            spriteRequested = true;
            await spriteGate;
            await route.continue();
        });

        try {
            await page.locator("#mini-map").click();
            await expect
                .poll(() => page.evaluate(() => window.__everydashcam.state.map!.getPitch()))
                .toBeGreaterThan(20);
            await page.locator("#map-settings-toggle").click();
            const popover = page.locator('[data-marker-control="map-popover"]');
            await popover.locator('button[data-marker-shape="suv"]').click();
            await expect.poll(() => spriteRequested).toBe(true);
            const preview = popover.locator('button[data-marker-shape="suv"] canvas');
            await expect.poll(() => markerPixels(preview)).toBeTruthy();
            const perspectivePixels = await markerPixels(preview);
            await expect.poll(() => markerPixels(mainMarker)).toBe(perspectivePixels);
            await page.keyboard.press("Escape");
            await page.locator('.map-follow-seg[data-follow-mode="follow"]').click();
            await expect(mainMarker).toHaveAttribute("data-marker-render-key", "suv:#ff9000:overhead");
            await page.locator('.map-follow-seg[data-follow-mode="chase"]').click();
            await expect(mainMarker).toHaveAttribute("data-marker-render-key", "suv:#ff9000");
            await expect.poll(() => markerPixels(mainMarker)).toBe(perspectivePixels);

            releaseSprite();
            await expect.poll(() => markerPixels(miniMarker)).not.toBe(arrowPixels);
            expect(await markerPixels(miniMarker), "the delayed overhead art finishes painting").toBeTruthy();
            expect(await markerPixels(miniMarker)).not.toBe(perspectivePixels);
            await expect(mainMarker).toHaveAttribute("data-marker-render-key", "suv:#ff9000");
            expect(await markerPixels(mainMarker), "the latest camera view survives the late image load").toBe(
                perspectivePixels,
            );
        } finally {
            releaseSprite();
        }
    });
});

test("map provider choice applies immediately and survives a reload", { tag: "@golden-map" }, async ({ page }) => {
    await loadTrip(page);
    await page.locator("#settings-btn").click();
    const provider = page.getByRole("combobox", { name: "Map provider" });
    await expect(provider).toHaveValue("openfreemap");
    await expect(provider.locator('option[value="openfreemap"]')).toHaveText("OpenFreeMap (recommended)");
    await provider.selectOption("osm-vector");
    await expect
        .poll(() => page.evaluate(() => Boolean(window.__everydashcam.state.map?.getSource("osm-shortbread"))))
        .toBe(true);

    await gotoApp(page, "ru");
    await page.locator("#settings-btn").click();
    const russianProvider = page.getByRole("combobox", { name: "Источник карты" });
    await expect(russianProvider).toHaveValue("osm-vector");
    await expect(russianProvider.locator('option[value="openfreemap"]')).toHaveText("OpenFreeMap (рекомендуется)");
    await russianProvider.selectOption("openfreemap");
    await expect(russianProvider).toHaveValue("openfreemap");
});

test("map preferences persist and use the page language", async ({ page }) => {
    await page.locator("#settings-btn").click();
    const modal = page.locator("#settings-modal");
    const style = modal.getByRole("combobox", { name: "Map style", exact: true });
    const theme = modal.getByRole("combobox", { name: "Map theme", exact: true });
    const buildings = modal.getByRole("checkbox", { name: "3D buildings", exact: true });
    await expect(style).toHaveValue("classic");
    await expect(theme).toHaveValue("auto");
    await expect(buildings).toBeChecked();
    await expect(buildings).toHaveAccessibleDescription("Only in tilted view.");
    await style.selectOption("road");
    await theme.selectOption("light");
    await buildings.uncheck();

    await gotoApp(page, "ru");
    await page.locator("#settings-btn").click();
    const russianStyle = modal.getByRole("combobox", { name: "Стиль карты", exact: true });
    const russianTheme = modal.getByRole("combobox", { name: "Тема карты", exact: true });
    const russianBuildings = modal.getByRole("checkbox", { name: "Объёмные здания", exact: true });
    await expect(russianStyle).toHaveValue("road");
    await expect(russianStyle.locator("option:checked")).toHaveText("Дорожная");
    await expect(russianTheme).toHaveValue("light");
    await expect(russianTheme.locator('option[value="auto"]')).toHaveText("Как в интерфейсе");
    await expect(russianBuildings).not.toBeChecked();
    await expect(russianBuildings).toHaveAccessibleDescription("Только в наклонном виде.");
});

test("map gear and general settings share style, theme and buildings choices", async ({ page }) => {
    await loadTrip(page);
    await pausePlayback(page);
    await page.locator(".mini-map").click();
    const hasBuildings = (): Promise<boolean> =>
        page.evaluate(() => Boolean(window.__everydashcam.state.map?.getLayer("dc-buildings-3d")));
    await expect.poll(hasBuildings).toBe(true);
    const darkBackground = await mapBackground(page);
    expect(darkBackground).toBeTruthy();
    await page.locator("#map-settings-toggle").click();
    const popover = page.locator("#map-settings-popover");
    await page.locator("#map-style-select").selectOption("minimal");
    await page.locator("#map-theme-select").selectOption("dark");
    await page.locator("#map-buildings3d-toggle").uncheck();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.mapReady)).toBe(true);
    await expect.poll(hasBuildings).toBe(false);
    await expect(popover).toBeVisible();
    await expect(page.locator("#settings-map-style-select")).toHaveValue("minimal");
    await expect(page.locator("#settings-map-theme-select")).toHaveValue("dark");
    await expect(page.locator("#settings-map-buildings3d-toggle")).not.toBeChecked();

    await page.keyboard.press("Escape");
    await expect(page.locator("#map-settings-toggle")).toBeFocused();
    await page.locator("#settings-btn").click();
    await page.locator("#settings-map-style-select").selectOption("road");
    await page.locator("#settings-map-theme-select").selectOption("light");
    await page.locator("#settings-map-buildings3d-toggle").check();
    await expect.poll(hasBuildings).toBe(true);
    await expect
        .poll(async () => {
            const background = await mapBackground(page);
            return background !== undefined && background !== darkBackground;
        })
        .toBe(true);
    await expect(page.locator("html")).toHaveClass(/dc-dark/);
    await expect(page.locator("#map-style-select")).toHaveValue("road");
    await expect(page.locator("#map-theme-select")).toHaveValue("light");
    await expect(page.locator("#map-buildings3d-toggle")).toBeChecked();
    await page.locator("#settings-modal-header-close").click();
    await page.locator("#map-settings-toggle").click();
    await expect(popover).toBeVisible();
    await expect(page.locator("#map-style-select")).toHaveValue("road");
    await expect(page.locator("#map-theme-select")).toHaveValue("light");
    const lightBackground = await mapBackground(page);
    await page.locator('.theme-toggle-btn[data-theme="light"]').click();
    await page.locator('.theme-toggle-btn[data-theme="dark"]').click();
    await expect(page.locator("html")).toHaveClass(/dc-dark/);
    await expect.poll(() => mapBackground(page)).toBe(lightBackground);
    await page.locator("#map-settings-toggle").click();
    await page.locator("#map-theme-select").selectOption("auto");
    await expect.poll(() => mapBackground(page)).toBe(darkBackground);
});

test("style changes preserve the manually positioned map camera", async ({ page }) => {
    await loadTrip(page);
    await pausePlayback(page);
    await page.locator(".mini-map").click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.mapReady)).toBe(true);
    await page.locator('.map-follow-seg[data-follow-mode="off"]').click();
    await page.evaluate(() => {
        window.__everydashcam.state.map!.jumpTo({ center: [65, 45], zoom: 17, bearing: 20, pitch: 0 });
    });
    const darkBackground = await mapBackground(page);
    expect(darkBackground).toBeTruthy();
    await page.locator("#map-settings-toggle").click();
    await page.locator("#map-style-select").selectOption("road");
    await page.locator("#map-theme-select").selectOption("light");
    await expect
        .poll(async () => {
            const background = await mapBackground(page);
            return background !== undefined && background !== darkBackground;
        })
        .toBe(true);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.map!;
                return Boolean(map.getSource("openmaptiles")) && window.__everydashcam.state.mapReady;
            }),
        )
        .toBe(true);
    const camera = await page.evaluate(() => {
        const { map, followMode } = window.__everydashcam.state;
        return {
            lng: map!.getCenter().lng,
            lat: map!.getCenter().lat,
            zoom: map!.getZoom(),
            bearing: map!.getBearing(),
            pitch: map!.getPitch(),
            followMode,
        };
    });
    expect(camera.lng).toBeCloseTo(65);
    expect(camera.lat).toBeCloseTo(45);
    expect(camera.zoom).toBeCloseTo(17);
    expect(camera.bearing).toBeCloseTo(20);
    expect(camera.pitch).toBeCloseTo(0);
    expect(camera.followMode).toBe("off");
});

test("open map settings stay inside the pane after resizing and on mobile", async ({ page }) => {
    await loadTrip(page);
    await pausePlayback(page);
    await page.locator(".mini-map").click();
    await page.locator("#map-settings-toggle").click();
    await page.locator("#video-map-resize").focus();
    await page.keyboard.press("End");

    const staysInsidePane = async (): Promise<boolean> => {
        const pane = await boxOf(page, ".map-wrap");
        const popover = await boxOf(page, "#map-settings-popover");
        return (
            popover.x >= pane.x &&
            popover.y >= pane.y &&
            popover.x + popover.width <= pane.x + pane.width + 1 &&
            popover.y + popover.height <= pane.y + pane.height + 1
        );
    };
    await expect.poll(staysInsidePane).toBe(true);
    await page.locator("#map-style-select").focus();
    await page.locator("#map-style-select").selectOption("minimal");
    await expect(page.locator("#map-style-select")).toBeFocused();
    await expect(page.locator("#map-style-select")).toHaveValue("minimal");

    await page.setViewportSize(MOBILE);
    await expect.poll(staysInsidePane).toBe(true);
    await expect
        .poll(async () => {
            const popover = await boxOf(page, "#map-settings-popover");
            const playerBar = await boxOf(page, ".player-bar");
            return popover.y + popover.height <= playerBar.y;
        })
        .toBe(true);
    await page.locator("#map-theme-select").selectOption("light");
    await expect(page.locator("#map-theme-select")).toHaveValue("light");
    await page.locator('#map-label-scale-segment button[data-value="2"]').click();
    await expect(page.locator('#map-label-scale-segment button[data-value="2"]')).toHaveAttribute(
        "aria-pressed",
        "true",
    );
});

test("map credits and scale remain separate and accessible in a narrow pane", async ({ page }) => {
    await loadTrip(page);
    await pausePlayback(page);
    await page.locator(".mini-map").click();
    await page.locator("#video-map-resize").focus();
    await page.keyboard.press("End");

    const controlsFit = async (): Promise<boolean> => {
        const pane = await boxOf(page, ".map-wrap");
        const scale = await boxOf(page, ".map-wrap .maplibregl-ctrl-scale");
        const credits = await boxOf(page, ".map-wrap .dc-map-attrib");
        const inside = [scale, credits].every(
            (box) =>
                box.x >= pane.x &&
                box.y >= pane.y &&
                box.x + box.width <= pane.x + pane.width + 1 &&
                box.y + box.height <= pane.y + pane.height + 1,
        );
        const separate =
            scale.x + scale.width <= credits.x ||
            credits.x + credits.width <= scale.x ||
            scale.y + scale.height <= credits.y ||
            credits.y + credits.height <= scale.y;
        return inside && separate;
    };
    await expect.poll(controlsFit).toBe(true);

    await page.setViewportSize(MOBILE);
    if ((await page.locator(".sidebar").getAttribute("data-drawer-open")) === "true") {
        await page.locator("#topbar-burger").click();
    }
    await expect.poll(controlsFit).toBe(true);
    await page.locator(".viewer").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    await expect.poll(controlsFit).toBe(true);
    await expect
        .poll(async () => {
            const credits = await boxOf(page, ".map-wrap .dc-map-attrib");
            const playerBar = await boxOf(page, ".player-bar");
            return credits.y + credits.height <= playerBar.y;
        })
        .toBe(true);
    await expect
        .poll(() =>
            page
                .locator(".map-wrap .dc-map-attrib a")
                .first()
                .evaluate((link) => {
                    const box = link.getBoundingClientRect();
                    return link.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
                }),
        )
        .toBe(true);
});

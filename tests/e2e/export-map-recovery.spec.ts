import type { Page, Route } from "@playwright/test";

import { DESKTOP, expect, gotoApp, loadTrip, openExport, presetLocalStorage, test } from "./_fixtures.js";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await openExport(page);
});

async function solidTile(page: Page): Promise<Buffer> {
    const encoded = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#20a040";
        ctx.fillRect(0, 0, 256, 256);
        return canvas.toDataURL().split(",")[1]!;
    });
    return Buffer.from(encoded, "base64");
}

async function previewPixel(page: Page): Promise<number[]> {
    return page.locator("#player-map-overlay-canvas").evaluate((el) => {
        const canvas = el as HTMLCanvasElement;
        return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data);
    });
}

async function expectPreviewSettles(page: Page): Promise<void> {
    const writes = await page.locator("#player-map-overlay-canvas").evaluate(
        (canvas) =>
            new Promise<number>((resolve) => {
                let mutations = 0;
                let frames = 0;
                const observer = new MutationObserver((entries) => {
                    mutations += entries.length;
                });
                observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
                const next = (): void => {
                    if (++frames < 12) requestAnimationFrame(next);
                    else {
                        observer.disconnect();
                        resolve(mutations);
                    }
                };
                requestAnimationFrame(next);
            }),
    );
    expect(writes, "an idle map must not keep resnapshotting the paused preview").toBe(0);
}

test("repaints a paused map preview after its provider fails without rebuilding the map", async ({ page }) => {
    const tile = await solidTile(page);
    let vectorTileRequests = 0;
    let shouldFailTiles = false;
    await page.route("https://vector.openstreetmap.org/**", (route) => {
        if (!new URL(route.request().url()).pathname.endsWith("/0/0/0.mvt")) vectorTileRequests++;
        if (shouldFailTiles) return route.abort();
        return route.fulfill({ body: Buffer.alloc(0), headers: { "access-control-allow-origin": "*" } });
    });
    await page.locator("#export-panel-ov-map").check();
    await page.locator("#export-map-provider-select").selectOption("osm-vector");
    await expect.poll(() => vectorTileRequests).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#export-map-snapshot-host")).toHaveCount(1);
    await expect.poll(() => previewPixel(page)).toEqual([0, 0, 0, 128]);
    const playhead = await page.locator("#player").evaluate((el) => (el as HTMLVideoElement).currentTime);
    await page.locator("#export-map-snapshot-host").evaluate((el) => {
        (el as HTMLElement).dataset.providerTest = "true";
    });

    // Changing scale requests uncached tiles while preserving the snapshot map.
    await page.route("https://tile.openstreetmap.org/**", (route) =>
        route.fulfill({ body: tile, contentType: "image/png", headers: { "access-control-allow-origin": "*" } }),
    );
    shouldFailTiles = true;
    await page.getByRole("slider", { name: "Map scale", exact: true }).evaluate((element) => {
        const slider = element as HTMLInputElement;
        slider.value = slider.max;
        slider.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await expect.poll(() => previewPixel(page)).toEqual([32, 160, 64, 255]);
    await expect(page.locator('[data-provider-test="true"]')).toHaveCount(1);
    await expect(page.locator("#export-map-provider-select")).toHaveValue("osm-vector");
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("openfreemap");
    await expect(page.locator("#player")).toHaveJSProperty("paused", true);
    await expect(page.locator("#player")).toHaveJSProperty("currentTime", playhead);
    await expectPreviewSettles(page);
    await expect(page.locator('button[data-mapmode="north"]')).toHaveClass(/is-active/);
    await expect(page.locator('button[data-mapmode="chase"]')).toBeDisabled();
    await expect(page.locator("#export-map-chase-controls")).toBeHidden();
    await expect(page.locator('button[data-maptheme="dark"]')).toBeDisabled();
    await expect(page.locator("#export-map-appearance-unavailable")).toBeVisible();
    const savedMode = await page.evaluate(() => {
        const prefs = JSON.parse(localStorage.getItem("everydashcam:export:overlays") ?? "null");
        return prefs?.overlayMap?.mode;
    });
    expect(savedMode, "a fallback does not replace the preferred camera mode").toBe("chase");
    await page.locator("#export-map-provider-select").selectOption("openfreemap");
    shouldFailTiles = false;
    await page.locator("#export-map-provider-select").selectOption("osm-vector");
    await expect(page.locator('button[data-mapmode="chase"]')).toBeEnabled();
    await expect(page.locator('button[data-mapmode="chase"]')).toHaveClass(/is-active/);
    await expect(page.locator("#export-map-chase-controls")).toBeVisible();
    await expect(page.locator('button[data-maptheme="dark"]')).toBeEnabled();
    await page.locator("#export-panel-close").click();
    await expect(page.locator("#export-map-snapshot-host")).toHaveCount(0);
});

test("repaints a paused map preview when tiles arrive after the bounded snapshot wait", async ({ page }) => {
    const tile = await solidTile(page);
    let pendingTile: Route | undefined;
    await page.route("**/preview-map-tile.png", (route) => {
        pendingTile = route;
    });
    await page.route("**/styles/**/neon.json", (route) =>
        route.fulfill({
            json: {
                version: 8,
                sources: {
                    delayed: {
                        type: "raster",
                        tiles: [new URL("/preview-map-tile.png", page.url()).href],
                        tileSize: 256,
                        maxzoom: 0,
                    },
                },
                layers: [
                    { id: "background", type: "background", paint: { "background-color": "#000000" } },
                    { id: "delayed", type: "raster", source: "delayed", paint: { "raster-fade-duration": 0 } },
                ],
            },
        }),
    );
    await page.locator("#export-panel-ov-map").check();
    await expect.poll(() => Boolean(pendingTile)).toBe(true);
    await expect.poll(() => previewPixel(page)).toEqual([0, 0, 0, 255]);
    const playhead = await page.locator("#player").evaluate((el) => (el as HTMLVideoElement).currentTime);
    if (!pendingTile) throw new Error("preview tile request is missing");

    await pendingTile.fulfill({ body: tile, contentType: "image/png" });

    await expect.poll(() => previewPixel(page)).toEqual([32, 160, 64, 255]);
    await expect(page.locator("#player")).toHaveJSProperty("paused", true);
    await expect(page.locator("#player")).toHaveJSProperty("currentTime", playhead);
    await expectPreviewSettles(page);
    await page.locator("#export-panel-close").click();
    await expect(page.locator("#export-map-snapshot-host")).toHaveCount(0);
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Page, expect } from "@playwright/test";
import { portableFilename } from "../../src/portable/release-tags.mjs";
import { loadTrip, pausePlayback, presetLocalStorage, SAMPLE_70MAI } from "../e2e/_fixtures.js";
import { expectLocalRoute, test, TEST_MAP_TILE } from "./_fixtures.js";

let directory: string;
const version = "v2026.01.01";
const YANDEX_TILES = /^https:\/\/tiles\.api-maps\.yandex\.ru\/v1\/tiles\/?\?/;

test.beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "portable-yandex-"));
    execFileSync(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/build-portable.mjs",
            "--locale",
            "en",
            "--version",
            version,
            "--out-dir",
            directory,
        ],
        {
            cwd: resolve("."),
            env: { ...process.env, PORTABLE_YANDEX_TILES_API_KEY: "portable-e2e-yandex-key" },
            stdio: "pipe",
        },
    );
});

test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function expectYandexMap(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page
                .locator(".dc-map-logo img")
                .evaluateAll(
                    (images) =>
                        images.length > 0 &&
                        images.every(
                            (image) =>
                                image instanceof HTMLImageElement &&
                                image.naturalWidth > 0 &&
                                image.src.startsWith("data:image/svg+xml"),
                        ),
                ),
        )
        .toBe(true);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.miniMap;
                return Boolean(
                    map?.getSource("yandex") &&
                        map.isStyleLoaded() &&
                        map.isSourceLoaded("yandex") &&
                        map.getLayer("trip-line"),
                );
            }),
        )
        .toBe(true);
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("yandex");
}

test("renders configured Yandex tiles and the embedded attribution logo from a file", async ({ page }) => {
    await page.route(YANDEX_TILES, (route) =>
        route.fulfill({
            body: TEST_MAP_TILE,
            contentType: "image/png",
            headers: { "access-control-allow-origin": "*" },
        }),
    );
    await presetLocalStorage(page);
    await page.goto(pathToFileURL(join(directory, portableFilename(version, "en"))).href);
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await page.locator("#settings-btn").click();
    const provider = page.locator("#settings-map-provider-select");
    await provider.selectOption("route-only");
    await page.locator("#settings-map-theme-miami-86").check();
    await provider.selectOption("yandex");
    await page.locator("#settings-modal-header-close").click();
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await expectYandexMap(page);
    const mini = page.locator("#mini-map");
    await expect(mini).toHaveAttribute("data-shape", "rect");
    await expect(mini.locator(".car-marker__canvas")).toHaveAttribute("data-marker-render-key", "arrow:#ff9000");
    await page.locator("#settings-btn").click();
    await provider.selectOption("route-only");
    await expect(mini).toHaveAttribute("data-shape", "circle");
    await expect(mini.locator(".car-marker__canvas")).toHaveAttribute(
        "data-marker-render-key",
        "arrow:#f4f4f2:miami-86",
    );
});

test("preserves the selected Yandex preference through local fallback and reconnection", async ({ page, requests }) => {
    let deniedTiles = 0;
    let canLoadTiles = false;
    await page.route(YANDEX_TILES, (route) => {
        const url = new URL(route.request().url());
        expect(
            url.searchParams.get("apikey") === "portable-e2e-yandex-key",
            "the isolated build uses its test key",
        ).toBe(true);
        if (canLoadTiles) {
            return route.fulfill({
                body: TEST_MAP_TILE,
                contentType: "image/png",
                headers: { "access-control-allow-origin": "*" },
            });
        }
        deniedTiles++;
        return route.fulfill({ status: 403, body: "denied", headers: { "access-control-allow-origin": "*" } });
    });
    await presetLocalStorage(page);
    await page.goto(pathToFileURL(join(directory, portableFilename(version, "en"))).href);
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("openfreemap");
    await page.locator("#settings-btn").click();
    await page.locator("#settings-map-provider-select").selectOption("yandex");
    await page.locator("#settings-modal-header-close").click();
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await expectLocalRoute(page);
    expect(deniedTiles).toBeGreaterThan(0);
    for (const host of ["tiles.openfreemap.org", "vector.openstreetmap.org", "tile.openstreetmap.org"]) {
        expect(
            requests.some((url) => new URL(url).hostname === host),
            `${host} is tried after the denied Yandex tiles`,
        ).toBe(true);
    }
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("yandex");
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:mapProvider"))).toBe("yandex");
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    canLoadTiles = true;
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expectYandexMap(page);
});

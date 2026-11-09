import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Page, expect, test as base } from "@playwright/test";
import { readPortableArtifacts } from "../../scripts/_portable-artifacts.mjs";
import { PORTABLE_UPDATE_URL } from "../../src/portable/manifest.mjs";

const artifactDirectory = resolve("dist-portable");
export const manifest = readPortableArtifacts(resolve(artifactDirectory, "manifest.json"), true);
export const TEST_MAP_TILE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
);

export function isPortableMapRequest(rawUrl: string): boolean {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    return (
        [
            "https://tiles.openfreemap.org",
            "https://vector.openstreetmap.org",
            "https://tile.openstreetmap.org",
        ].includes(url.origin) ||
        (url.origin === "https://tiles.api-maps.yandex.ru" && url.pathname.replace(/\/+$/, "") === "/v1/tiles")
    );
}

function redactMapCredentials(message: string): string {
    return message.replace(/(https:\/\/tiles\.api-maps\.yandex\.ru\/[^\s?)]*)\?[^\s)]+/g, "$1?[redacted]");
}

export const test = base.extend<{ requests: string[] }>({
    requests: [
        async ({ page }, use) => {
            const requests: string[] = [];
            let navigations = 0;
            page.on("request", (request) => {
                if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
                if (/^https?:/.test(request.url())) {
                    requests.push(request.url());
                    expect(request.method(), "portable requests are public GETs").toBe("GET");
                    expect(request.postData()).toBeNull();
                }
            });
            await page.route(/^https?:/, (route) => route.abort());
            await use(requests);
            expect(
                requests
                    .filter((url) => url !== PORTABLE_UPDATE_URL && !isPortableMapRequest(url))
                    .map(redactMapCredentials),
                "portable requests are limited to update metadata and public map tiles",
            ).toEqual([]);
            // A failed initial update check may retry once when the browser reconnects.
            expect(requests.filter((url) => url === PORTABLE_UPDATE_URL).length).toBeLessThanOrEqual(navigations * 2);
        },
        { auto: true },
    ],
    page: async ({ page }, use) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(redactMapCredentials(error.message)));
        page.on("console", (message) => {
            if (message.type() !== "error") return;
            const url = message.location().url;
            const text = message.text();
            if (
                (url === PORTABLE_UPDATE_URL || (url.startsWith("https:") && isPortableMapRequest(url))) &&
                /^Failed to load resource: (?:net::ERR_|the server responded with a status of (?:403|429|503)\b)/.test(
                    text,
                )
            )
                return;
            if (
                /^\[map\] maplibre (?:mini |trips )?error /.test(text) &&
                (/\bAbortError\b/.test(text) ||
                    [...text.matchAll(/https:\/\/[^\s)]+/g)].some(([url]) => isPortableMapRequest(url)))
            )
                return;
            errors.push(redactMapCredentials(text));
        });
        await use(page);
        expect(errors, "uncaught errors and CSP violations").toEqual([]);
    },
});

export async function expectLocalRoute(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { map, miniMap } = window.__everydashcam.state;
                return [map, miniMap].every(
                    (view) =>
                        view?.isStyleLoaded() &&
                        view.getLayer("trip-line") &&
                        view.isSourceLoaded("trip-line") &&
                        Object.values(view.getStyle().sources).every((source) => source.type === "geojson"),
                );
            }),
        )
        .toBe(true);
}

export async function openPortable(
    page: Page,
    outputDirectory: string,
    locale = "en",
    filename = "renamed offline viewer.html",
): Promise<string> {
    const artifact = manifest.files[locale];
    expect(artifact, `portable artifact exists for ${locale}`).toBeDefined();
    const directory = resolve(outputDirectory, "Карта памяти с пробелами", "de");
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, filename);
    await copyFile(resolve(artifactDirectory, artifact!.filename), target);
    const url = pathToFileURL(target).href;
    await page.goto(url);
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    return url;
}

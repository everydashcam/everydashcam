import type { Page } from "@playwright/test";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import { DESKTOP, expect, gotoApp, loadTrip, openExport, presetLocalStorage, test } from "./_fixtures.js";

const assets = computeTrackerAssets("build");
const wasm = assets.app.ort.webgpu.wasm;
const runtimeUrl = "parts" in wasm ? wasm.parts[0]!.url : wasm.url;
const faceUrl = assets.app.models.face;
const sharedDetectionUrls = [
    ...("parts" in wasm ? wasm.parts.map((part) => part.url) : [wasm.url]),
    assets.app.ort.webgpu.moduleUrl,
    assets.app.models.tracker,
];
const plainWasm = assets.app.ort.wasm.wasm;
const plainRuntimeUrls = [
    ...("parts" in plainWasm ? plainWasm.parts.map((part) => part.url) : [plainWasm.url]),
    assets.app.ort.wasm.moduleUrl,
];

test.use({ serviceWorkers: "block" });

async function openDetection(page: Page, { delayedCache = false, gatedRuntimeUrl = runtimeUrl } = {}): Promise<void> {
    await page.clock.install();
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await page.addInitScript(
        ({ urls, gatedUrls, delayedCache }) => {
            // The download gate runs before inference and must work without a
            // physical GPU. A worker starting during this test is a failure.
            Object.defineProperty(navigator, "gpu", {
                value: { requestAdapter: async () => ({}) },
                configurable: true,
            });
            if (delayedCache) {
                const discovered = new Promise<void>((resolve) => {
                    window.addEventListener("e2e:release-blur-cache", () => resolve(), { once: true });
                });
                const nativeCacheMatch = caches.match.bind(caches);
                caches.match = async (input, options) => {
                    const url = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
                    if (!urls.includes(url)) return nativeCacheMatch(input, options);
                    await discovered;
                    return new Response(new Uint8Array([1, 2, 3]));
                };
            } else {
                for (const url of urls) localStorage.setItem(`everydashcam:blurAssetDownloaded:${url}`, "1");
            }
            const nativeFetch = window.fetch.bind(window);
            const requests: string[] = [];
            const aborted: string[] = [];
            window.fetch = (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
                if (!urls.includes(url)) return nativeFetch(input, init);
                requests.push(url);
                document.documentElement.dataset.blurWarmRequests = JSON.stringify(requests);
                if (!gatedUrls.includes(url)) return nativeFetch(input, init);
                const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
                return new Promise<Response>((resolve, reject) => {
                    const cleanup = (): void => {
                        signal?.removeEventListener("abort", onAbort);
                        window.removeEventListener("e2e:release-blur-asset", onRelease);
                    };
                    const onAbort = (): void => {
                        cleanup();
                        aborted.push(url);
                        document.documentElement.dataset.blurWarmAborted = JSON.stringify(aborted);
                        reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
                    };
                    const onRelease = (event: Event): void => {
                        if (!(event instanceof CustomEvent) || event.detail !== url) return;
                        cleanup();
                        resolve(nativeFetch(input, init));
                    };
                    signal?.addEventListener("abort", onAbort, { once: true });
                    window.addEventListener("e2e:release-blur-asset", onRelease);
                    if (signal?.aborted) onAbort();
                });
            };
        },
        { urls: assets.urls, gatedUrls: [gatedRuntimeUrl, faceUrl], delayedCache },
    );
    await gotoApp(page, "en");
    await loadTrip(page);
    await openExport(page);
}

test("Cancel stops a remembered download and its queued checkbox without starting detection", async ({ page }) => {
    const trackerWorkers: string[] = [];
    page.on("worker", (worker) => {
        if (worker.url().includes("tracker-worker-")) trackerWorkers.push(worker.url());
    });
    await openDetection(page);
    await page.locator("#export-panel-blur-plates").check();
    const strip = page.locator(".export-panel__blur-detect-strip");
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await page.locator("#export-panel-blur-faces").check();
    await page.clock.fastForward(2000);
    expect(trackerWorkers, "the debounce cannot bypass an unfinished warm").toEqual([]);
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-aborted", JSON.stringify([runtimeUrl]));
    await expect(strip).toBeHidden();
    await page.clock.fastForward(2000);
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-requests", JSON.stringify([runtimeUrl]));
    expect(trackerWorkers, "Cancel also prevents the queued detection pass").toEqual([]);
});

test("cancelling the second WASM part keeps the first part ready for retry", async ({ page }) => {
    if (!("parts" in wasm)) throw new Error("this regression requires a split runtime");
    const first = wasm.parts[0]!.url;
    const second = wasm.parts[1]!.url;
    await openDetection(page, { gatedRuntimeUrl: second });
    const checkbox = page.locator("#export-panel-blur-plates");
    const strip = page.locator(".export-panel__blur-detect-strip");
    await checkbox.check();
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-requests", JSON.stringify([first, second]));
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-aborted", JSON.stringify([second]));
    await expect(strip).toBeHidden();
    await checkbox.uncheck();
    await checkbox.check();
    await expect(page.locator("html")).toHaveAttribute(
        "data-blur-warm-requests",
        JSON.stringify([first, second, second]),
    );
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(strip).toBeHidden();
});

test("a second checkbox warms its model after the first download and remains cancellable", async ({ page }) => {
    const trackerWorkers: string[] = [];
    page.on("worker", (worker) => {
        if (worker.url().includes("tracker-worker-")) trackerWorkers.push(worker.url());
    });
    await openDetection(page);
    await page.locator("#export-panel-blur-plates").check();
    const strip = page.locator(".export-panel__blur-detect-strip");
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await page.locator("#export-panel-blur-faces").check();
    await page.evaluate(
        (url) => window.dispatchEvent(new CustomEvent("e2e:release-blur-asset", { detail: url })),
        runtimeUrl,
    );
    await expect
        .poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.blurWarmRequests ?? "[]")))
        .toContain(faceUrl);
    const warmed: string[] = await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.blurWarmRequests ?? "[]"),
    );
    expect(warmed).toContain(assets.app.models.plate);
    expect(warmed, "automatic detection warms its shared runtime and ViTTrack before inference").toEqual(
        expect.arrayContaining(sharedDetectionUrls),
    );
    expect(
        warmed.filter((url) => plainRuntimeUrls.includes(url)),
        "Follow runtime remains lazy",
    ).toEqual([]);
    expect(new Set(warmed).size, "both checkboxes share the tracker and runtime downloads").toBe(warmed.length);
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await page.clock.fastForward(2000);
    expect(trackerWorkers, "the first checkbox cannot start a pass before the second model is ready").toEqual([]);
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-aborted", JSON.stringify([faceUrl]));
    await expect(strip).toBeHidden();
    expect(trackerWorkers).toEqual([]);
});

test("Cancel stops the automatic tracker download through the detection strip", async ({ page }) => {
    const trackerWorkers: string[] = [];
    page.on("worker", (worker) => {
        if (worker.url().includes("tracker-worker-")) trackerWorkers.push(worker.url());
    });
    await openDetection(page, { gatedRuntimeUrl: assets.app.models.tracker });
    await page.locator("#export-panel-blur-plates").check();
    const strip = page.locator(".export-panel__blur-detect-strip");
    await expect
        .poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.blurWarmRequests ?? "[]")))
        .toContain(assets.app.models.tracker);
    const warmed: string[] = await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.blurWarmRequests ?? "[]"),
    );
    expect(warmed).toEqual(expect.arrayContaining(sharedDetectionUrls));
    expect(
        warmed.filter((url) => plainRuntimeUrls.includes(url)),
        "Follow runtime remains lazy",
    ).toEqual([]);
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await expect(page.locator(".export-panel__blur-tracker")).toBeHidden();
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
        "data-blur-warm-aborted",
        JSON.stringify([assets.app.models.tracker]),
    );
    await expect(strip).toBeHidden();
    await page.clock.fastForward(2000);
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-requests", JSON.stringify(warmed));
    expect(trackerWorkers, "cancelling a tracker dependency cannot start automatic inference").toEqual([]);
});

test("cached detection warms after delayed discovery without remembered download history", async ({ page }) => {
    await openDetection(page, { delayedCache: true });
    const checkbox = page.locator("#export-panel-blur-plates");
    const strip = page.locator(".export-panel__blur-detect-strip");
    await checkbox.check();
    await expect(strip.getByRole("button", { name: "Download & scan", exact: true })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-blur-warm-requests");
    await page.evaluate(() => window.dispatchEvent(new Event("e2e:release-blur-cache")));
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-requests", JSON.stringify([runtimeUrl]));
    await expect(checkbox).toBeChecked();
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(strip).toBeHidden();
    await page.clock.fastForward(2000);
    await expect(page.locator("html")).toHaveAttribute("data-blur-warm-requests", JSON.stringify([runtimeUrl]));
});

test("detection consent follows connectivity and dismisses without downloading", async ({ page }) => {
    await openDetection(page, { delayedCache: true });
    const checkbox = page.locator("#export-panel-blur-plates");
    const strip = page.locator(".export-panel__blur-detect-strip");
    await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
        window.dispatchEvent(new Event("offline"));
    });
    await checkbox.check();
    await expect(strip).toContainText("You're offline.");
    await expect(strip).not.toHaveClass(/is-error/);
    await expect(strip.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(page.locator(".export-panel__blur-tracker")).toBeHidden();

    await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
        window.dispatchEvent(new Event("online"));
    });
    await expect(strip.getByRole("button", { name: "Download & scan", exact: true })).toBeVisible();
    await strip.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await expect(strip).toBeHidden();
    await expect(page.locator("html")).not.toHaveAttribute("data-blur-warm-requests");
});

test("consent updates the download size when another detection kind is selected", async ({ page }) => {
    await openDetection(page, { delayedCache: true });
    const strip = page.locator(".export-panel__blur-detect-strip");
    await page.locator("#export-panel-blur-plates").check();
    const message = strip.locator(".export-panel__blur-tracker-msg");
    const platesOnly = await message.innerText();
    await page.locator("#export-panel-blur-faces").check();
    await expect(message).not.toHaveText(platesOnly);
    const downloadSize = (text: string): number => Number(/about (\d+) MB/.exec(text)?.[1]);
    expect(downloadSize(await message.innerText())).toBeGreaterThan(downloadSize(platesOnly));
    await page.locator("#export-panel-blur-faces").uncheck();
    await expect(message).toHaveText(platesOnly);
    await expect(page.locator("html")).not.toHaveAttribute("data-blur-warm-requests");
});

test("a stalled detection download retries and clears its error presentation", async ({ page }) => {
    await openDetection(page);
    await page.locator("#export-panel-blur-plates").check();
    const strip = page.locator(".export-panel__blur-detect-strip");
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await page.clock.fastForward(30_000);
    await expect(strip).toHaveClass(/is-error/);
    await expect(strip).toContainText("That didn't download.");
    await expect(page.locator(".export-panel__blur-tracker")).toBeHidden();

    await strip.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(strip.getByRole("progressbar")).toBeVisible();
    await expect(strip).not.toHaveClass(/is-error/);
    await strip.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(strip.getByRole("button", { name: "Download & scan", exact: true })).toBeVisible();
    await strip.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(strip).toBeHidden();
});

for (const action of ["Not now", "uncheck"] as const) {
    test(`${action} cancels detection while cached models are still being discovered`, async ({ page }) => {
        await openDetection(page, { delayedCache: true });
        const checkbox = page.locator("#export-panel-blur-plates");
        const strip = page.locator(".export-panel__blur-detect-strip");
        await checkbox.check();
        await expect(strip.getByRole("button", { name: "Download & scan", exact: true })).toBeVisible();
        if (action === "Not now") await strip.getByRole("button", { name: action, exact: true }).click();
        else await checkbox.uncheck();
        await expect(checkbox).not.toBeChecked();
        await expect(strip).toBeHidden();
        await page.evaluate(() => window.dispatchEvent(new Event("e2e:release-blur-cache")));
        await page.clock.fastForward(2000);
        await expect(page.locator("html")).not.toHaveAttribute("data-blur-warm-requests");
        await expect(checkbox).not.toBeChecked();
        await expect(strip).toBeHidden();
    });
}

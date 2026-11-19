import type { Page } from "@playwright/test";

import { expect, presetLocalStorage, test } from "./_fixtures.js";

async function withPendingScripts(page: Page, check: () => Promise<void>): Promise<void> {
    let releaseScripts = (): void => {};
    const scriptsGate = new Promise<void>((resolve) => {
        releaseScripts = resolve;
    });
    let pendingScripts = 0;
    await page.route(/\/assets\/[^/?]+\.js$/, async (route) => {
        pendingScripts += 1;
        await scriptsGate;
        await route.continue();
    });
    try {
        await check();
        expect(pendingScripts, "app scripts are still downloading").toBeGreaterThan(0);
    } finally {
        releaseScripts();
    }
}

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        addEventListener(
            "dc:ready",
            () => {
                document.documentElement.dataset.e2eReady = "true";
            },
            { once: true },
        );
    });
});

for (const { locale, heading } of [
    { locale: "en", heading: "Free dashcam player in your browser" },
    { locale: "ru", heading: "Бесплатный плеер видеорегистратора в браузере" },
]) {
    test(`${locale} first visit shows the localized landing while the app downloads`, async ({ page }) => {
        let fileChoosers = 0;
        page.on("filechooser", () => {
            fileChoosers += 1;
        });
        await withPendingScripts(page, async () => {
            await page.goto(`/${locale}/`, { waitUntil: "commit" });
            await expect(page.locator(".landing-hero-h1")).toBeVisible();
            await expect(page.locator(".landing-hero-h1")).toContainText(heading);
            await expect(page.locator("html")).toHaveAttribute("lang", locale);
            await expect(page.locator("html")).not.toHaveClass(/is-loading/);
            await expect(page.locator("#landing-cta")).toHaveClass(/is-pending/);
            await expect(page.locator("#landing-cta")).toBeDisabled();
            await expect(page.locator("#folder-input")).toBeDisabled();
            await expect(page.locator("#file-input")).toBeDisabled();
            await expect(page.locator("html")).not.toHaveAttribute("data-e2e-ready", "true");

            // Bypass Playwright's enabled check to check both click targets before the picker handlers attach.
            await page.locator(".landing-drop-text").click({ force: true });
            await page.locator("#landing-cta").click({ force: true });
            expect(fileChoosers, "loading controls cannot lose a selection before handlers attach").toBe(0);
        });

        await expect(page.locator("#landing-cta")).not.toHaveClass(/is-pending/);
        await expect(page.locator("html")).toHaveAttribute("data-e2e-ready", "true");
        await expect(page.locator("#landing-cta")).toBeEnabled();
        await expect(page.locator("#folder-input")).toBeEnabled();
        await expect(page.locator("#file-input")).toBeEnabled();
    });
}

test("an origin with stored data keeps the splash until the app is ready", async ({ page }) => {
    await page.route("**/__landing-storage-seed", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Storage setup</title>" }),
    );
    await page.goto("/__landing-storage-seed");
    await page.evaluate(
        () =>
            new Promise<void>((resolve, reject) => {
                const request = indexedDB.open("landing-returning-session");
                request.onsuccess = () => {
                    request.result.close();
                    resolve();
                };
                request.onerror = () => reject(request.error);
            }),
    );

    await withPendingScripts(page, async () => {
        await page.goto("/en/", { waitUntil: "commit" });
        await expect(page.locator("#landing-cta")).toBeAttached();
        expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBeGreaterThan(0);
        await expect(page.locator("html")).toHaveClass(/is-loading/);
        await expect(page.locator("#dc-loader")).toBeVisible();
        await expect(page.locator(".landing-hero-h1")).toBeHidden();
        await expect(page.locator("html")).not.toHaveAttribute("data-e2e-ready", "true");
    });

    await expect(page.locator("html")).toHaveAttribute("data-e2e-ready", "true");
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await expect(page.locator(".landing-hero-h1")).toBeVisible();
});

test("viewer warmup waits for the landing image to finish loading", async ({ page }) => {
    const workers: string[] = [];
    page.on("worker", (worker) => workers.push(worker.url()));

    let releaseImage = (): void => {};
    const imageGate = new Promise<void>((resolve) => {
        releaseImage = resolve;
    });
    let pendingImages = 0;
    await page.route(/\/landing\/app-desktop-\d+\.webp$/, async (route) => {
        pendingImages += 1;
        await imageGate;
        await route.continue();
    });

    try {
        await page.goto("/en/", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".landing-cta").first()).not.toHaveClass(/is-pending/);
        expect(pendingImages, "the hero image is still downloading").toBeGreaterThan(0);

        // The browser has an idle main thread while its hero image is pending.
        // A preload scheduled from module evaluation would run in this slot.
        await page.evaluate(
            () => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 4000 })),
        );
        expect(await page.evaluate(() => document.readyState)).toBe("interactive");
        expect(workers, "no speculative viewer workers start before load").toEqual([]);
    } finally {
        releaseImage();
    }

    await page.waitForLoadState("load");
    await expect.poll(() => workers.length, { message: "viewer warmup runs after load" }).toBeGreaterThan(0);
});

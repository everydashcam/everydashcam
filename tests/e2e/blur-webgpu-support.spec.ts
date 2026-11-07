import {
    DESKTOP,
    expect,
    gotoApp,
    installInMemoryExportCapture,
    loadTrip,
    MOBILE,
    openExport,
    pausePlayback,
    presetLocalStorage,
    readInMemoryDownload,
    test,
} from "./_fixtures.js";
import { showOnlyCameras } from "./_cameras.js";

test.use({ serviceWorkers: "block", viewerMap: "route-only" });

const gpuNote = {
    en: "Automatic plate and face finding isn't available in this browser. Try the latest Chrome or Edge.",
    ru: "Автоматический поиск номеров и лиц недоступен в этом браузере. Попробуй последнюю версию Chrome или Edge.",
};

for (const locale of ["en", "ru"] as const) {
    test(`automatic blur rejects an adapter without info (${locale})`, async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await page.addInitScript(() => {
            // An older browser may expose WebGPU but neither synchronous info API.
            Object.defineProperty(navigator, "gpu", {
                value: { requestAdapter: async () => ({}) },
                configurable: true,
            });
        });
        const runtimeRequests: string[] = [];
        page.on("request", (request) => {
            if (/ort\.webgpu|tracker-worker-/.test(request.url())) runtimeRequests.push(request.url());
        });
        await gotoApp(page, locale);
        await loadTrip(page);
        await pausePlayback(page);
        await openExport(page);
        await expect(page.locator("#export-panel-blur-plates")).toBeDisabled();
        await expect(page.locator("#export-panel-blur-faces")).toBeDisabled();
        await expect(page.getByText(gpuNote[locale], { exact: true })).toBeVisible();
        await expect(page.locator(".export-panel__blur-add-btn")).toBeEnabled();
        await expect(page.locator("#export-panel-save-btn")).toBeEnabled();
        expect(runtimeRequests).toEqual([]);
    });
}

test.describe("export after worker WebGPU rejection", () => {
    const copy = {
        en: {
            download: "Download & scan",
            error: "Automatic plate and face finding isn't available in this browser. Try the latest Chrome or Edge, or turn off automatic finding and add blur areas by hand before saving.",
        },
        ru: {
            download: "Загрузить и искать",
            error: "Автоматический поиск номеров и лиц недоступен в этом браузере. Открой записи в последней версии Chrome или Edge либо отключи автопоиск и добавь области размытия вручную перед сохранением.",
        },
    };

    for (const locale of ["en", "ru"] as const) {
        test(`preserves the blur choice and explains how to save (${locale})`, async ({ page }, info) => {
            await presetLocalStorage(page);
            await installInMemoryExportCapture(page);
            await page.setViewportSize(DESKTOP);
            await page.addInitScript(() => {
                Object.defineProperty(navigator, "gpu", {
                    value: { requestAdapter: async () => ({ info: {} }) },
                    configurable: true,
                });
            });
            // Keep the real worker and ORT initialization boundary. Only its browser
            // API differs from the page's, as it can on affected browser installations.
            await page.route("**/assets/tracker-worker-*.js", async (route) => {
                const response = await route.fetch();
                await route.fulfill({
                    response,
                    body: `Object.defineProperty(navigator, "gpu", {
                        value: { requestAdapter: async () => ({}) }, configurable: true
                    });\n${await response.text()}`,
                });
            });
            const workers: string[] = [];
            page.on("worker", (worker) => {
                if (worker.url().includes("tracker-worker-")) workers.push(worker.url());
            });
            await gotoApp(page, locale);
            await loadTrip(page);
            await pausePlayback(page);
            await openExport(page);
            // A single channel can be copied after the user turns off automatic blur.
            await showOnlyCameras(page, ["front"]);
            const plates = page.locator("#export-panel-blur-plates");
            await plates.check();
            await page
                .locator(".export-panel__blur-detect-strip")
                .getByRole("button", { name: copy[locale].download })
                .click();
            await expect(page.locator(".export-panel__note").filter({ hasText: gpuNote[locale] })).toBeVisible();
            await expect(plates).toBeChecked();
            await expect(plates).toBeEnabled();
            await expect(page.locator("#export-panel-blur-faces")).toBeDisabled();
            // The capture also sees source-video URLs created during ingest.
            await page.evaluate(() => {
                (window as unknown as { __downloads: Blob[] }).__downloads = [];
            });
            await page.locator("#export-panel-save-btn").click();
            const status = page.locator(".export-panel__error-status");
            await expect(status).toBeVisible();
            await expect(status).toBeFocused();
            await expect(status).toHaveText(copy[locale].error);
            await expect(page.locator("#export-panel-done-summary")).toBeHidden();
            expect(await readInMemoryDownload(page), "selected blur must never be silently dropped").toBeNull();
            await page.screenshot({ path: info.outputPath(`webgpu-error-${locale}.png`) });
            await page.locator('.theme-toggle-btn[data-theme="light"]').click();
            await page.setViewportSize(MOBILE);
            await expect(status).toBeVisible();
            await page.screenshot({ path: info.outputPath(`webgpu-error-${locale}-mobile.png`) });
            await page.setViewportSize(DESKTOP);

            await page.locator("#export-panel-error .export-panel__primary-btn").click();
            await expect(plates).toBeChecked();
            await expect(plates).toBeEnabled();
            await plates.uncheck();
            await expect(plates).not.toBeChecked();
            await expect(plates).toBeDisabled();
            await page.locator("#export-panel-save-btn").click();
            await expect(page.locator("#export-panel-done-summary")).toBeVisible();
            await page.locator("#export-panel-done-summary button").click();
            const result = await readInMemoryDownload(page);
            expect(result?.len).toBeGreaterThan(1024);
            expect(result?.ftyp).toBe(true);
            expect(result?.moov).toBe(true);
            expect(workers).toHaveLength(1);
            expect(
                await page.evaluate(() =>
                    window.__everydashcam
                        .dumpLog()
                        .some((record) => (record as { msg?: string }).msg?.includes("tracker threads failed")),
                ),
            ).toBe(false);
        });
    }
});

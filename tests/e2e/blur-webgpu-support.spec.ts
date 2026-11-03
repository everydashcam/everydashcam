import {
    DESKTOP,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

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

test("worker WebGPU rejection preserves the blur choice without a thread retry", async ({ page }) => {
    await presetLocalStorage(page);
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
    await gotoApp(page, "en");
    await loadTrip(page);
    await pausePlayback(page);
    await openExport(page);
    const plates = page.locator("#export-panel-blur-plates");
    await plates.check();
    await page.locator(".export-panel__blur-detect-strip").getByRole("button", { name: "Download & scan" }).click();
    await expect(page.locator(".export-panel__note").filter({ hasText: gpuNote.en })).toBeVisible();
    await expect(plates).toBeChecked();
    await expect(plates).toBeEnabled();
    await expect(page.locator("#export-panel-blur-faces")).toBeDisabled();
    expect(workers).toHaveLength(1);
    expect(
        await page.evaluate(() =>
            window.__everydashcam
                .dumpLog()
                .some((record) => (record as { msg?: string }).msg?.includes("tracker threads failed")),
        ),
    ).toBe(false);
    await plates.uncheck();
    await expect(plates).not.toBeChecked();
    await expect(plates).toBeDisabled();
    await expect(page.locator("#export-panel-save-btn")).toBeEnabled();
});

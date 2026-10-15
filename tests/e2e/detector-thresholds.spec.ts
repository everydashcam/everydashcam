import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    expect,
    gotoApp,
    hasWebGpuAdapter,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

test.use({ viewerMap: "route-only", reducedMotion: "reduce" });

for (const locale of ["en", "ru"] as const) {
    for (const [size, viewport] of [
        ["desktop", DESKTOP],
        ["mobile", MOBILE],
    ] as const) {
        test(`detection thresholds are labeled and reset on ${locale} ${size}`, async ({ page }, info) => {
            await presetLocalStorage(page);
            await page.setViewportSize(viewport);
            await gotoApp(page, locale);
            test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable - detection is WebGPU-only");
            await loadTrip(page, SAMPLE_70MAI);
            await pausePlayback(page);
            await openExport(page);
            const settings = page.locator(".export-panel__detect-settings");
            await expect(settings).not.toHaveAttribute("open", "");
            await settings.locator("summary").click();
            const faces = settings.getByRole("slider", { name: locale === "en" ? "Faces" : "Лица", exact: true });
            const plates = settings.getByRole("slider", {
                name: locale === "en" ? "License plates" : "Номера",
                exact: true,
            });
            const reset = settings.getByRole("button", {
                name: locale === "en" ? "Reset defaults" : "Вернуть по умолчанию",
            });
            await expect(faces).toHaveValue("0.5");
            await expect(plates).toHaveValue("0.5");
            await expect(faces).toHaveAttribute("aria-valuetext", locale === "en" ? "0.50" : "0,50");
            await expect(reset).toBeDisabled();
            await faces.focus();
            await page.keyboard.press("Home");
            await expect(faces).toHaveValue("0.1");
            await plates.focus();
            await page.keyboard.press("End");
            await expect(plates).toHaveValue("1");
            await expect(reset).toBeEnabled();
            await reset.click();
            await expect(faces).toHaveValue("0.5");
            await expect(plates).toHaveValue("0.5");
            await expect(reset).toBeDisabled();
            const defaults = settings.getByText(locale === "en" ? "Default: 0.50" : "По умолчанию: 0,50", {
                exact: true,
            });
            await expect(defaults).toHaveCount(2);
            await expect(defaults.nth(0)).toBeVisible();
            await expect(defaults.nth(1)).toBeVisible();
            expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
            const bounds = await settings.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
            await settings.screenshot({ path: info.outputPath("threshold-settings.png") });
        });
    }
}

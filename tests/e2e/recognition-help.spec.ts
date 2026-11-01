import {
    DESKTOP,
    MOBILE,
    SAMPLE_NOGPS,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
});

for (const locale of ["en", "ru"] as const) {
    test(`no-GPS recordings offer contextual help without an automatic warning (${locale})`, async ({ page }) => {
        await page.setViewportSize(locale === "en" ? DESKTOP : MOBILE);
        await gotoApp(page, locale);
        await loadTrip(page, SAMPLE_NOGPS);
        const help = page.locator('.player-no-gps [data-feedback-preset="gps"]');
        await expect(help).toBeVisible();
        await expect(page.locator("#recognition-banner")).toBeHidden();
        await expect(page.locator(".player-no-gps")).toContainText(locale === "en" ? "not found" : "не найдены");
        await shot(page, `recognition-no-gps-${locale}`);
        await help.click();
        await expect(page.locator("#feedback-modal")).toBeVisible();
        await expect(page.locator("#feedback-step-report")).toBeVisible();
        await expect(page.locator("#feedback-step-recordings")).toBeHidden();
        await expect(page.locator("#recognition-banner")).toBeHidden();
        await expect(page.locator("#feedback-modal")).toHaveCSS("opacity", "1");
        await shot(page, `recognition-gps-help-${locale}`);
    });
}

test("the no-GPS help fits the timeline panel in narrow fullscreen", async ({ page }) => {
    // Russian wraps the note to the most lines; the fullscreen panel is
    // narrower than the inline one.
    await page.setViewportSize({ width: 320, height: 740 });
    await gotoApp(page, "ru");
    await loadTrip(page, SAMPLE_NOGPS);
    let entry = page.locator("#player-fullscreen");
    if (!(await entry.isVisible())) {
        const label = (await entry.getAttribute("aria-label")) ?? "";
        expect(label).not.toBe("");
        await page.locator("#player-overflow").click();
        entry = page.locator("#player-overflow-menu").getByRole("button", { name: label, exact: true });
    }
    await entry.click();
    await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    const overflow = async (): Promise<number> => {
        const panel = await boxOf(page, "#player-chart");
        const help = await boxOf(page, '.player-no-gps [data-feedback-preset="gps"]');
        return help.y + help.height - (panel.y + panel.height);
    };
    await expect.poll(overflow, { message: "the help link ends inside the panel" }).toBeLessThanOrEqual(0);
    await shot(page, "recognition-no-gps-fullscreen-ru");
});

test("recognized multi-camera recordings stay silent and offer camera help by their controls", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    await loadTrip(page);
    await expect(page.locator("#recognition-banner")).toBeHidden();
    const help = page.locator('#top-panel-channels [data-feedback-preset="cameras"]');
    await expect(help).toBeVisible();
    await shot(page, "recognition-camera-help-desktop");
    await help.click();
    await expect(page.locator("#feedback-step-report")).toBeVisible();
    await expect(page.locator("#feedback-step-recordings")).toBeHidden();
    await expect(page.locator("#feedback-modal")).toContainText("whole memory card folder");
});

test("a single camera keeps camera help available in the view menu", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    await loadTrip(page, SAMPLE_NOGPS);
    await page.locator("#player-view-menu").click();
    await page.locator('#player-view-menu-popover [data-feedback-preset="cameras"]').click();
    await expect(page.locator("#feedback-step-report")).toBeVisible();
    await expect(page.locator("#feedback-modal")).toContainText("whole memory card folder");
});

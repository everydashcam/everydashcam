import { expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

for (const [name, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
] as const) {
    test.describe(name, () => {
        test.use({ hasTouch: name === "phone", viewport: { width, height } });
        test("settings navigation and map theme previews", async ({ page }, info) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await presetLocalStorage(page, { theme: name === "desktop" ? "dark" : "light" });
            await gotoApp(page, "ru");
            const settings = page.locator("#settings-btn");
            async function openSettings(): Promise<void> {
                if (await settings.isVisible()) await settings.click();
                else {
                    await page.locator("#topbar-overflow").click();
                    await page
                        .locator("#topbar-overflow-menu")
                        .getByRole("button", { name: "Настройки", exact: true })
                        .click();
                }
            }
            await openSettings();
            const modal = page.locator("#settings-modal");
            const jump = modal.locator("#settings-jump");
            if (name === "desktop") await modal.getByRole("link", { name: "Карта", exact: true }).click();
            else await jump.selectOption({ label: "Карта" });
            await expect(modal.getByRole("heading", { name: "Карта", exact: true })).toBeFocused();
            const miami = modal.getByRole("radio", { name: "Майами 86" });
            await miami.check();
            await expect(modal.locator("#settings-map-minimap-shape-select")).toHaveValue("circle");
            await miami.press("ArrowLeft");
            await expect(modal.getByRole("radio", { name: "ЛА 92" })).toBeChecked();
            await miami.check();
            await expect(jump).toHaveValue("settings-map-section");
            const content = modal.locator(".settings-content");
            expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
            const preview = modal.locator(".settings-themes__preview").first();
            expect(
                await preview.evaluate(async (el) => {
                    const image = new Image();
                    image.src = getComputedStyle(el).backgroundImage.slice(5, -2);
                    await image.decode();
                    return image.naturalWidth;
                }),
            ).toBe(1152);
            await modal.locator(".modal-card").screenshot({ path: info.outputPath(`settings-map-${name}.png`) });
            await page.keyboard.press("Escape");
            await openSettings();
            await expect(modal.getByRole("heading", { name: "Воспроизведение", exact: true })).toBeInViewport();
            await expect(jump).toHaveValue("settings-playback-section");
            await expect(miami).toBeChecked();
        });
    });
}

test("reaches the last settings section on a short landscape screen", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await presetLocalStorage(page);
    await gotoApp(page);
    await page.locator("#settings-btn").click();
    const modal = page.locator("#settings-modal");
    const resetLink = modal.getByRole("link", { name: "Reset app data", exact: true });
    await resetLink.click();
    await expect(resetLink).toHaveAttribute("aria-current", "location");
    await expect(modal.locator("#settings-reset-btn")).toBeInViewport();
    await expect(modal.locator("#settings-modal-header-close")).toBeInViewport();
});

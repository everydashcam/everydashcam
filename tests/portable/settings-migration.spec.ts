import { expect } from "@playwright/test";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test("omits the hosted migration section while keeping notes import", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("portable-settings"));
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-migration-section")).toHaveCount(0);
    await expect(page.locator("#migration-banner")).toHaveCount(0);
    await expect(page.locator("#migration-restore-modal")).toHaveCount(0);
    await expect(page.locator("#settings-notes-import-btn")).toBeVisible();
});

test("renders the theme previews from the standalone HTML", async ({ page }, info) => {
    await openPortable(page, info.outputPath("portable-theme-previews"));
    await page.locator("#settings-btn").click();
    const preview = page.locator('.settings-themes__preview[data-theme="vice-city"]');
    const rendered = await preview.evaluate(async (el) => {
        const image = new Image();
        image.src = getComputedStyle(el).backgroundImage.slice(5, -2);
        await image.decode();
        return image.src.startsWith("data:image/webp") && image.naturalWidth > 0;
    });
    expect(rendered).toBe(true);
});

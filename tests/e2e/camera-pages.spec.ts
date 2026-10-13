import { expect, shot, test } from "./_fixtures.js";

for (const locale of ["en", "ru"] as const) {
    for (const width of [390, 1440]) {
        test(`camera page opens local recordings in ${locale} at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`/${locale}/cameras/avylet/`);
            await expect(page.locator("h1")).toContainText("Avylet A1");
            await expect(page.locator(".vp-models")).toContainText("A1");
            await expect(page.locator(".vp-steps li")).toHaveCount(3);
            await page.evaluate(() => document.fonts.ready);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await shot(page, `camera-avylet-${locale}-${width}`);
            const cta = page.locator("a.vp-cta").first();
            await expect(cta).toHaveAttribute("href", `/${locale}/?vendor=avylet`);
            await cta.click();
            await expect(page).toHaveURL(new RegExp(`/${locale}/\\?vendor=avylet$`));
            await expect(page.locator("#landing-cta")).toBeVisible();
            await expect(page.locator("#landing-cta")).toBeEnabled();
        });
    }
}

test("catalog labels an English camera page without inventing a Portuguese translation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pt/cameras/");
    const card = page.locator("#camera-avylet");
    const english = card.getByRole("link", { name: "Saiba mais em inglês" });
    await expect(english).toHaveAttribute("href", "/en/cameras/avylet/");
    await expect(english).toHaveAttribute("hreflang", "en");
    await card.scrollIntoViewIfNeeded();
    await shot(page, "camera-catalog-pt-mobile");
    await english.click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("h1")).toContainText("Avylet A1");
});

test("video-only camera page keeps GPS limitations visible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/en/cameras/hp/");
    await expect(page.locator(".vp-note").first()).toContainText("do not contain readable GPS");
    await expect(page.locator('.vp-feature-links a[href*="overlay"]')).toHaveCount(0);
    await shot(page, "camera-hp-mobile");
});

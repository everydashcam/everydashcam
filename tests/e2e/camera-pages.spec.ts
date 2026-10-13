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

for (const locale of ["en", "ru", "de", "es", "fr", "pl", "pt", "zh", "ja", "ko"]) {
    test(`established camera guidance remains readable in ${locale}`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/${locale}/cameras/70mai/`);
        await expect(page.locator("article")).toContainText("GPSData*.txt");
        await expect(page.locator("article")).toContainText("A510");
        await expect(page.locator(".vp-models")).not.toContainText("A810S");
        await expect(page.locator("a.vp-cta").first()).toHaveAttribute("href", `/${locale}/?vendor=70mai`);
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `tests/e2e/screenshots/camera-70mai-${locale}-390.png`, fullPage: true });
        if (locale === "en" || locale === "ru") {
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.screenshot({ path: `tests/e2e/screenshots/camera-70mai-${locale}-1440.png`, fullPage: true });
        }
    });
}

for (const locale of ["en", "ru"]) {
    test(`camera catalog presents brands without partial model lists in ${locale}`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/${locale}/cameras/`);
        const card = page.locator("#camera-70mai");
        await expect(card).toContainText(locale === "en" ? "How to open recordings" : "Как открыть записи");
        await expect(card).not.toContainText("A810");
        await expect(card).not.toContainText("A510");
        await card.screenshot({ path: `tests/e2e/screenshots/camera-catalog-card-${locale}.png` });
        await card.getByRole("link").click();
        await expect(page).toHaveURL(new RegExp(`/${locale}/cameras/70mai/$`));
        await expect(page.locator(".vp-models")).toContainText("A810");
        await expect(page.locator(".vp-section h2").first()).toContainText(
            locale === "en" ? "Checked 70mai recordings" : "Проверенные записи 70mai",
        );
    });

    test(`unverified Garmin models do not appear as supported in ${locale}`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/${locale}/cameras/garmin/`);
        await expect(page.locator(".vp-models")).toHaveCount(0);
        await expect(page.locator("article")).not.toContainText("X310");
        await expect(page.locator('.vp-feature-links a[href*="overlay"]')).toHaveCount(0);
        await expect(page.locator("article")).toContainText(
            locale === "en" ? "not yet been verified" : "пока не проверен",
        );
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `tests/e2e/screenshots/camera-garmin-${locale}-390.png`, fullPage: true });
    });
}

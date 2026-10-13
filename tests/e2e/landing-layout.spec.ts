import { getLandingBrands } from "../../vite-plugins/supported-brands.js";
import { expect, gotoApp, presetLocalStorage, shot, test } from "./_fixtures.js";

test.describe("landing layout", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page, { theme: "light" });
    });

    for (const locale of ["en", "ru", "de"]) {
        test(`FAQ keeps seven answers and matching structured data in ${locale}`, async ({ page }) => {
            await page.setViewportSize(locale === "en" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
            await gotoApp(page, locale);
            const faq = page.locator(".landing-faq");
            const items = faq.locator("details");
            await expect(items).toHaveCount(7);
            const visibleEntries = await items.evaluateAll((elements) =>
                elements.map((element) => ({
                    "@type": "Question",
                    name: element.querySelector("summary")?.textContent?.trim(),
                    acceptedAnswer: {
                        "@type": "Answer",
                        text: element.querySelector(".landing-faq-body")?.textContent?.trim(),
                    },
                })),
            );
            const jsonLd = await page.locator("#faq-jsonld").textContent();
            expect(JSON.parse(jsonLd ?? "null")).toEqual({
                "@context": "https://schema.org",
                "@type": "FAQPage",
                mainEntity: visibleEntries,
            });
            await faq.scrollIntoViewIfNeeded();
            await shot(page, `landing-faq-${locale}`);
            await items.first().locator("summary").click();
            await expect(items.first().locator("a")).toBeVisible();
            await expect(items.first().locator("a")).toHaveAttribute("href", `/${locale}/cameras/`);
            const help = items.nth(5);
            await help.locator("summary").click();
            await expect(help.locator("a")).toBeVisible();
            await expect(help.locator("a")).toHaveAttribute("href", "/add-my-camera");
            await expect(help.locator("a")).toHaveAttribute("target", "_blank");
            await shot(page, `landing-faq-help-${locale}`);
        });

        test(`folder dock keeps its action inside the panel in ${locale}`, async ({ page }) => {
            await page.setViewportSize({ width: 320, height: 568 });
            await gotoApp(page, locale);
            const landing = page.locator("#landing");
            await expect(landing).toBeVisible();
            await page.evaluate(() => document.fonts.ready);
            await landing.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
            });
            const dock = page.locator("#landing-dock");
            await expect(dock).toBeVisible();
            for (const width of [320, 390, 768, 1024]) {
                await page.setViewportSize({ width, height: 568 });
                await expect
                    .poll(() =>
                        dock.evaluate((element) => {
                            const action = element.querySelector("button");
                            if (!action) return false;
                            const panel = element.getBoundingClientRect();
                            const button = action.getBoundingClientRect();
                            return (
                                panel.left >= 0 &&
                                panel.right <= innerWidth &&
                                button.left >= panel.left &&
                                button.right <= panel.right &&
                                element.scrollWidth <= element.clientWidth + 1
                            );
                        }),
                    )
                    .toBe(true);
            }
            await page.setViewportSize({ width: 390, height: 844 });
            await shot(page, `landing-footer-${locale}`);
        });
    }

    test("language choices support keyboard selection and focus return", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoApp(page, "en");
        const toggle = page.locator("#lang-toggle");
        const menu = page.locator("#lang-menu");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(menu.getByRole("menuitemradio", { name: "English", exact: true })).toBeFocused();
        await expect(menu.getByRole("menuitemradio", { name: "English", exact: true })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await page.keyboard.press("End");
        await expect(menu.getByRole("menuitemradio").last()).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(toggle).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Space");
        await expect(menu).toBeHidden();
        await expect(toggle).toBeFocused();
        await toggle.click();
        await menu.getByRole("menuitemradio", { name: "Русский", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/ru\/$/);
        await expect(page.locator("#landing h1")).toContainText(/[а-яё]/i);
    });
});

test("home links to the camera catalog and comparison hub in every locale", async ({ request }) => {
    for (const locale of ["en", "ru", "de", "es", "fr", "pl", "pt", "zh", "ja", "ko"] as const) {
        const response = await request.get(`/${locale}/`);
        expect(response.ok(), locale).toBe(true);
        const html = await response.text();
        const anchors = html.match(/<a\b[^>]*>/g) ?? [];
        const links = anchors.flatMap((anchor) => /\bhref="([^"]+)"/.exec(anchor)?.[1] ?? []);
        expect(links, `${locale}: camera catalog`).toContain(`/${locale}/cameras/`);
        expect(links, `${locale}: comparisons`).toContain(`/${locale}/alternatives/`);

        const catalog = await request.get(`/${locale}/cameras/`);
        expect(catalog.ok(), `${locale}: camera catalog`).toBe(true);
        const catalogHtml = await catalog.text();
        const catalogAnchors = catalogHtml.match(/<a\b[^>]*>/g) ?? [];
        const catalogLinks = catalogAnchors.flatMap((anchor) => /\bhref="([^"]+)"/.exec(anchor)?.[1] ?? []);
        for (const brand of getLandingBrands().filter((brand) => brand.locales.includes(locale))) {
            expect(catalogLinks, `${locale}: ${brand.displayName}`).toContain(`/${locale}/cameras/${brand.slug}/`);
        }
    }
});

test.describe("language menu on touch screens", () => {
    test.use({ hasTouch: true, viewport: { width: 844, height: 390 } });

    test("all languages remain reachable in a short landscape window", async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await page.locator("#lang-toggle").click();
        const menu = page.locator("#lang-menu");
        await expect(menu).toBeVisible();
        const bounds = await menu.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390);
        const last = menu.getByRole("menuitemradio").last();
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
        expect((await last.boundingBox())!.height).toBeGreaterThanOrEqual(40);
        await last.click();
        await expect(page).toHaveURL(/\/ko\/$/);
    });
});

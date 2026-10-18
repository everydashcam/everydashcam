import { expect, test } from "./_fixtures.js";

test.describe("standalone page typography", () => {
    test("a narrow comparison table can be scrolled with the keyboard", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.goto("/en/alternatives/dashcam-viewer/");
        const table = page.getByRole("region", { name: "Dashcam Viewer vs everydashcam" });
        await table.focus();
        await expect(table).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    });

    for (const lang of ["en", "ru"]) {
        test(`loads the shared text font across ${lang} page templates`, async ({ page }) => {
            const paths = [
                `/${lang}/cameras/`,
                `/${lang}/cameras/70mai/`,
                `/${lang}/alternatives/`,
                `/${lang}/alternatives/dashcam-viewer/`,
                `/${lang}/combine-dashcam-cameras-into-one-video/`,
                `/${lang}/privacy/`,
                `/${lang}/terms/`,
                `/${lang}/add-my-camera/`,
                `/404.html?lang=${lang}`,
                `/migrate/?lang=${lang}`,
            ];
            for (const path of paths) {
                await page.goto(path);
                await expect(page.locator("html")).toHaveAttribute("lang", lang);
                const fonts = await page.evaluate(
                    async (sample) => {
                        await document.fonts.ready;
                        return {
                            body: getComputedStyle(document.body).fontFamily,
                            available: (await document.fonts.load("16px Inter", sample)).length,
                        };
                    },
                    lang === "ru" ? "Пример" : "Example",
                );
                expect(fonts.body, path).toMatch(/^"?Inter"?,/);
                expect(fonts.available, `${path} has an Inter face for its language`).toBeGreaterThan(0);
            }
        });
    }

    test("camera submission commands fit a narrow viewport in every language", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.goto("/en/add-my-camera/");
        const languages = await page
            .locator("[data-set-lang]")
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-set-lang")!));
        for (const lang of languages) {
            await page.locator(`[data-set-lang="${lang}"]`).click();
            await expect(page.locator(`article[data-lang="${lang}"]`)).toBeVisible();
            const width = await page.evaluate(async () => {
                await document.fonts.ready;
                return {
                    content: document.documentElement.scrollWidth,
                    viewport: document.documentElement.clientWidth,
                };
            });
            expect(width.content, `${lang} command does not widen the page`).toBeLessThanOrEqual(width.viewport);
        }
    });
});

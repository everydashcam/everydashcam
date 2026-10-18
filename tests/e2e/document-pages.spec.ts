import { readFileSync } from "node:fs";
import { DESKTOP, MOBILE, expect, shot, test } from "./_fixtures.js";

for (const viewport of [DESKTOP, MOBILE]) {
    test(`localized document navigation preserves the host at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(() => localStorage.setItem("everydashcam:doc-lang", "en"));
        await page.goto("/ru/terms/?lang=en");
        const origin = new URL(page.url()).origin;
        await expect(page.locator("html")).toHaveAttribute("lang", "ru");
        await expect(page.locator("article")).toHaveCount(1);
        await expect(page.locator("h1")).toHaveText("Условия использования");
        await expect(page.locator('article a[href="/ru/privacy/"]')).toBeVisible();
        await page.locator('.lang-switcher a[data-set-lang="de"]').click();
        await expect(page).toHaveURL(`${origin}/de/terms/`);
        await expect(page.locator("html")).toHaveAttribute("lang", "de");
        await expect(page.locator("article")).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        await shot(page, `localized-terms-${viewport.width}`);
        await page.locator('.prevails a[href="/en/terms/"]').click();
        await expect(page).toHaveURL(`${origin}/en/terms/`);
        await expect(page.locator("h1")).toHaveText("Terms of Use");
    });
}

test("legacy documents honor query and saved language within the current host", async ({ page }) => {
    await page.goto("/en/privacy/");
    const origin = new URL(page.url()).origin;
    await page.evaluate(() => localStorage.setItem("everydashcam:doc-lang", "ru"));
    await page.goto("/privacy?lang=de&from=old#details");
    await expect(page).toHaveURL(`${origin}/de/privacy/?from=old#details`);
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await page.evaluate(() => localStorage.setItem("everydashcam:doc-lang", "ru"));
    await page.goto("/add-my-camera.html");
    await expect(page).toHaveURL(`${origin}/ru/add-my-camera/`);
    await expect(page.locator("article")).toHaveCount(1);
});

test.describe("document upgrade with an installed worker", () => {
    test.use({ serviceWorkers: "allow" });

    test("ignores the cached legacy runtime for localized documents and transition URLs", async ({ page, context }) => {
        // The pre-localized runtime changes the page language from ?lang= and
        // hides other articles. Its stable URL survives service-worker upgrades.
        const legacyRuntime = readFileSync("tests/e2e/__fixtures__/doc-lang-legacy.js", "utf8");
        const worker = readFileSync("public/sw.js", "utf8");
        await context.route("**/sw.js", (route) => route.fulfill({ contentType: "text/javascript", body: worker }));
        await page.goto("/en/terms/");
        await page.evaluate(async (cachedScript) => {
            await navigator.serviceWorker.register("/sw.js");
            await navigator.serviceWorker.ready;
            const runtime = await caches.open("everydashcam-runtime-v3");
            await runtime.put(
                "/doc-lang.js",
                new Response(cachedScript, { headers: { "Content-Type": "text/javascript" } }),
            );
            localStorage.setItem("everydashcam:doc-lang", "en");
        }, legacyRuntime);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

        const response = await page.goto("/ru/terms/?lang=en");
        expect(response?.fromServiceWorker()).toBe(true);
        await expect(page.locator("html")).toHaveAttribute("lang", "ru");
        await expect(page.locator("article")).toBeVisible();
        await expect(page.locator("h1")).toHaveText("Условия использования");

        await page.goto("/terms?lang=de&from=old#details");
        await expect(page).toHaveURL(/\/de\/terms\/\?from=old#details$/);
        await expect(page.locator("html")).toHaveAttribute("lang", "de");
        await expect(page.locator("article")).toBeVisible();
        expect(
            await page.evaluate(async () =>
                (await (await caches.open("everydashcam-runtime-v3")).match("/doc-lang.js"))?.text(),
            ),
        ).toBe(legacyRuntime);
    });
});

test.describe("documents without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    test("legacy fallback and language links reach real single-language pages", async ({ page }) => {
        await page.goto("/terms?lang=ru");
        await expect(page).toHaveURL(/\/en\/terms\/$/);
        await expect(page.locator("article")).toHaveCount(1);
        await expect(page.locator("h1")).toHaveText("Terms of Use");
        await page.locator('.lang-switcher a[data-set-lang="ru"]').click();
        await expect(page).toHaveURL(/\/ru\/terms\/$/);
        await expect(page.locator("html")).toHaveAttribute("lang", "ru");
        await expect(page.locator("article")).toHaveCount(1);
    });
});

import { DESKTOP, SAMPLE_70MAI, expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";
import { checkTripCardActions } from "./_trip-card-actions.js";

for (const { locale, theme, deviceScaleFactor } of [
    { locale: "en", theme: "light", deviceScaleFactor: 1 },
    { locale: "ru", theme: "dark", deviceScaleFactor: 1.5 },
] as const) {
    test.describe(`trip card mouse targets in ${locale}`, () => {
        test.use({ viewport: DESKTOP, deviceScaleFactor, viewerMap: "route-only" });

        test("corner actions own their centers and edges throughout a click", async ({ page }) => {
            await presetLocalStorage(page, { theme });
            await gotoApp(page, locale);
            if (locale === "ru") await page.locator(".lang-banner-dismiss").click();
            await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
            await checkTripCardActions(page);
            await expect(page.locator("#player-wrap")).toBeVisible();
            await page
                .locator("li.trip")
                .first()
                .screenshot({ path: `tests/e2e/screenshots/trip-card-actions-${locale}.png` });
        });
    });
}

test.describe("trip card touch targets", () => {
    test.use({
        viewport: { width: 320, height: 740 },
        hasTouch: true,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        viewerMap: "route-only",
    });

    test("corner actions take edge taps on a narrow phone", async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await checkTripCardActions(page, "touch");
        await expect(page.locator("body")).not.toHaveClass(/browsing/);
        await page.locator("#topbar-burger").click();
        await expect(page.locator("#sidebar")).toHaveAttribute("data-drawer-open", "true");
        await page.locator("li.trip").first().screenshot({ path: "tests/e2e/screenshots/trip-card-actions-phone.png" });
    });
});

import { expect } from "@playwright/test";
import { loadTrip, presetLocalStorage } from "../e2e/_fixtures.js";
import { manifest, openPortable, test } from "./_fixtures.js";

for (const locale of Object.keys(manifest.files)) {
    test(`${locale} stays fixed after moving the file and exposes the beta contact`, async ({
        page,
        requests,
    }, info) => {
        void requests;
        await presetLocalStorage(page, {
            lang: locale === "en" ? "ru" : "en",
            preferences: { "everydashcam:mapProvider": "osm-vector" },
        });
        await openPortable(page, info.outputPath("locales"), locale, "Переименованный просмотрщик.html");
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("#portable-full-version")).toHaveAttribute(
            "href",
            `https://everydashcam.app/${locale}/`,
        );
        await expect(page.locator("#no-recordings-how")).toHaveAttribute(
            "href",
            `https://everydashcam.app/${locale}/add-my-camera/`,
        );
        await expect(page.locator("#portable-github")).toBeVisible();
        await expect(
            page.locator(
                "#lang-toggle, #install-btn, #offline-use-btn, #offline-use-modal, #whats-new-btn, #switch-lang-modal, #support-banner, #settings-support-note",
            ),
        ).toHaveCount(0);
        await expect(page.locator('link[rel="manifest"], script[src], link[rel="stylesheet"]')).toHaveCount(0);
        await expect(page.locator("#settings-map-provider-select")).toHaveValue("osm-vector");
        expect(page.workers(), "the landing page does not start embedded workers").toHaveLength(0);
        await expect(page.locator(".portable-beta summary")).toBeVisible();
        await page.locator(".portable-beta summary").click();
        await expect(page.locator('.portable-beta a[href="mailto:feedback@everydashcam.app"]')).toBeVisible();
        await page.reload();
        await expect(page.locator("html")).not.toHaveClass(/is-loading/);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("#settings-map-provider-select")).toHaveValue("osm-vector");
        expect(page.workers()).toHaveLength(0);

        await page.setViewportSize({ width: 320, height: 740 });
        const beta = page.locator(".portable-beta summary");
        await expect(beta).toBeVisible();
        await beta.focus();
        await page.keyboard.press("Enter");
        const popover = page.locator(".portable-beta-popover");
        await expect(popover).toBeVisible();
        await expect(popover.locator('a[href="mailto:feedback@everydashcam.app"]')).toBeVisible();
        const bounds = await popover.boundingBox();
        expect(bounds, "beta explanation has visible bounds").not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

        await page.setViewportSize({ width: 320, height: 180 });
        const shortBounds = (await popover.boundingBox())!;
        expect(
            shortBounds.y + shortBounds.height,
            "beta explanation stays inside a short viewport",
        ).toBeLessThanOrEqual(180);
        const contact = popover.locator('a[href="mailto:feedback@everydashcam.app"]');
        await contact.focus();
        await expect(contact).toBeInViewport({ ratio: 1 });
        await page.setViewportSize({ width: 320, height: 740 });
        await beta.click();
        await expect(popover).toBeHidden();

        const fullVersion = page.locator("#portable-full-version");
        if (!(await fullVersion.isVisible())) {
            await page.locator("#topbar-overflow").click();
            const label = await fullVersion.textContent();
            expect(label).toBeTruthy();
            await expect(
                page.locator("#topbar-overflow-menu").getByRole("menuitem", { name: label!, exact: true }),
            ).toBeVisible();
            await expect(
                page.locator("#topbar-overflow-menu").getByRole("menuitem", { name: "GitHub", exact: true }),
            ).toBeVisible();
        }
    });
}

test.describe("touch header", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("keeps the edition, beta and primary controls inside a narrow screen with a trip open", async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await page.setViewportSize({ width: 320, height: 740 });
        await openPortable(page, info.outputPath("touch-header"), "es");
        const layout = () =>
            page.evaluate(() => ({
                viewport: innerWidth,
                content: document.documentElement.scrollWidth,
                scale: visualViewport?.scale,
            }));
        await expect.poll(layout).toEqual({ viewport: 320, content: 320, scale: 1 });
        await loadTrip(page);
        // The bell takes permanent header space whenever a notification exists.
        await page.locator("#notif-bell").evaluate((element) => {
            (element as HTMLButtonElement).hidden = false;
        });
        for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 740 });
            await expect.poll(layout).toEqual({ viewport: width, content: width, scale: 1 });
            await expect(page.locator(".portable-edition")).toBeVisible();
            for (const selector of [".portable-beta summary", "#topbar-burger", "#notif-bell", "#topbar-overflow"]) {
                const control = page.locator(selector);
                await expect(control).toBeVisible();
                const bounds = (await control.boundingBox())!;
                expect(bounds.x, `${selector} stays inside the left edge`).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width, `${selector} stays inside the right edge`).toBeLessThanOrEqual(width);
                const targetSize = selector === ".portable-beta summary" ? 24 : 40;
                expect(bounds.width).toBeGreaterThanOrEqual(targetSize);
                expect(bounds.height).toBeGreaterThanOrEqual(targetSize);
            }
        }
    });
});

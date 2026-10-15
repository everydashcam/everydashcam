import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    SCREENSHOT_DIR,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

test.describe("export controls", () => {
    test.use({ viewport: DESKTOP });

    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page, false);
    });

    test("desktop privacy and overlays start expanded and toggle from the keyboard", async ({ page }) => {
        for (const [title, name] of [
            ["Hide plates & faces", "privacy"],
            ["Overlays", "overlays"],
        ] as const) {
            const section = page.locator(".export-panel__disclosure").filter({
                has: page.locator(":scope > summary", { hasText: title }),
            });
            const summary = section.locator(":scope > summary");
            const controls = section.locator(":scope > fieldset");
            await expect(section).toHaveAttribute("open", "");
            await expect(controls).toBeVisible();
            await summary.focus();
            await page.keyboard.press("Enter");
            await expect(section).not.toHaveAttribute("open");
            await expect(controls).toBeHidden();
            await expect(summary).toBeFocused();
            await page.keyboard.press("Space");
            await expect(section).toHaveAttribute("open", "");
            await expect(controls).toBeVisible();
            await summary.evaluate((element) => element.blur());
            await page.mouse.move(0, 0);
            await section.screenshot({ path: `${SCREENSHOT_DIR}/export-disclosure-${name}.png` });
        }
        await page.locator('.theme-toggle-btn[data-theme="light"]').click();
        await page.mouse.move(0, 0);
        const sections = page.locator(".export-panel__disclosure");
        await sections.nth(0).screenshot({ path: `${SCREENSHOT_DIR}/export-disclosure-privacy-light.png` });
        await sections.nth(1).screenshot({ path: `${SCREENSHOT_DIR}/export-disclosure-overlays-light.png` });
    });

    test("output and overlay controls expose their labels and selected states", async ({ page }) => {
        const video = page.locator('.export-panel__seg-btn[data-mode="video"]');
        const gpx = page.locator('.export-panel__seg-btn[data-mode="gpx"]');
        await expect(video).toHaveAttribute("aria-pressed", "true");
        await gpx.click();
        await expect(gpx).toHaveAttribute("aria-pressed", "true");
        await expect(video).toHaveAttribute("aria-pressed", "false");
        await video.click();

        const map = page.locator('.export-panel__ov-row[data-widget="map"]');
        const name = map.getByRole("button");
        await expect(map.getByRole("checkbox")).toHaveAccessibleName(await name.innerText());
        await name.click();
        await expect(name).toHaveAttribute("aria-expanded", "true");
        const circle = page.locator('button[data-shape="circle"]');
        await circle.click();
        await expect(circle).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator('button[data-shape="rect"]')).toHaveAttribute("aria-pressed", "false");
        await name.click();
        await expect(name).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator("#export-panel-overlay-inspector")).toBeHidden();
    });

    test("closing the drawer restores focus and removes its controls from keyboard navigation", async ({ page }) => {
        await page.locator("#export-panel-close").click();
        await expect(page.locator("#player-export")).toBeFocused();
        await expect(page.locator("#export-panel")).toHaveAttribute("inert", "");
        await page.keyboard.press("Enter");
        await expect(page.locator("#export-panel")).toBeVisible();
        await expect(page.locator("#export-panel")).not.toHaveAttribute("inert", "");
    });

    test("changing export quality keeps the clip preview playing", async ({ page }) => {
        await page.locator("#export-trim-preview").click();
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
        await page.locator('.export-panel__radio input[value="low"]').check();
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
    });

    test("editing a blur zone keeps its timing control focused and deleting it returns to Add", async ({ page }) => {
        await page.locator(".export-panel__blur-add-btn").click();
        const layer = page.locator('.video-tile[data-channel="front"] .blur-draw-layer');
        await expect(layer).toBeVisible();
        const box = await layer.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height * 0.4);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.6, { steps: 6 });
        await page.mouse.up();
        await expect(page.locator(".export-panel__blur-row")).toHaveCount(1);
        await page.locator("#player-play").focus();
        await page.keyboard.press("5");
        const start = page.locator(".export-panel__blur-row-actions button").first();
        await start.click();
        await expect(start).toBeFocused();
        await page.locator(".export-panel__blur-del-btn").click();
        await expect(page.locator(".export-panel__blur-add-btn")).toBeFocused();
    });

    test.describe("mobile", () => {
        test.use({ viewport: MOBILE });

        test("privacy and overlays start collapsed", async ({ page }) => {
            for (const title of ["Hide plates & faces", "Overlays"]) {
                const section = page.locator(".export-panel__disclosure").filter({
                    has: page.locator(":scope > summary", { hasText: title }),
                });
                await expect(section).not.toHaveAttribute("open");
                await expect(section.locator(":scope > summary")).toBeVisible();
                await expect(section.locator(":scope > fieldset")).toBeHidden();
            }
        });
    });
});

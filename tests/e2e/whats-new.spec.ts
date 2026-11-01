// "What's new" changelog panel: the topbar dot lights only for a returning
// user with unacknowledged entries, opening the panel renders the localized
// entry list and clears the dot durably. The first-visit path asserts the
// quiet contract: no badge, acknowledgment stamped silently.

import { LATEST_CHANGELOG_ID } from "../../src/changelog/latest.js";
import { DESKTOP, expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

const SEEN_KEY = "everydashcam:changelog:lastSeenId";

test.describe("what's new panel", () => {
    // The sparkles button is the first topbar item to collapse into the kebab,
    // so a narrow default viewport would hide it and time the clicks out.
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize(DESKTOP);
    });

    test("stays quiet on first visit and stamps the acknowledgment", async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await expect(page.locator("#whats-new-btn")).toBeVisible();
        await expect(page.locator("#whats-new-dot")).toBeHidden();
        const stored = await page.evaluate((key) => localStorage.getItem(key), SEEN_KEY);
        expect(stored, "first visit must stamp the latest entry id").toBe(LATEST_CHANGELOG_ID);
    });

    test("lights the dot for a returning user and opening the panel clears it for good", async ({ page }) => {
        await presetLocalStorage(page);
        await page.addInitScript((key) => {
            try {
                localStorage.setItem(key, "2020-01-01.1");
            } catch {
                /* private mode - ignore */
            }
        }, SEEN_KEY);
        await gotoApp(page, "en");
        await expect(page.locator("#whats-new-dot")).toBeVisible();

        await page.locator("#whats-new-btn").click();
        const modal = page.locator("#whats-new-modal");
        await expect(modal).toBeVisible();
        await expect(modal.locator(".whats-new-group h3").first()).toBeVisible();
        await expect(modal.locator(".whats-new-item").first()).toBeVisible();
        await expect(page.locator("#whats-new-dot")).toBeHidden();

        await page.keyboard.press("Escape");
        await expect(modal).toBeHidden();

        // The acknowledgment is stamped durably. Asserted via storage, not a
        // reload: the addInitScript above re-seeds the stale id on every
        // navigation, so a reload would test the seeding, not the app.
        const stored = await page.evaluate((key) => localStorage.getItem(key), SEEN_KEY);
        expect(stored, "opening the panel must stamp the latest entry id").toBe(LATEST_CHANGELOG_ID);
    });

    test("renders the entry text in the page locale", async ({ page }) => {
        await presetLocalStorage(page, { lang: "ru" });
        await gotoApp(page, "ru");
        await page.locator("#whats-new-btn").click();
        const firstItem = page.locator("#whats-new-modal .whats-new-item").first();
        await expect(firstItem).toBeVisible();
        await expect(firstItem, "the ru page must show Russian entry text").toContainText(/[А-Яа-яЁё]/);
    });

    test("refreshes dates when reopened after changing the date format", async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await page.locator("#whats-new-btn").click();
        const modal = page.locator("#whats-new-modal");
        const heading = modal.locator(".whats-new-group h3").first();
        await expect(heading).toContainText(/[A-Za-z]+ \d+, \d{4}/);
        const localizedDate = await heading.innerText();
        await page.keyboard.press("Escape");

        await page.locator("#settings-btn").click();
        await page.locator("#settings-date-format-select").selectOption("iso");
        await page.locator("#settings-modal-close").click();
        await page.locator("#whats-new-btn").click();
        await expect(heading).toHaveText(LATEST_CHANGELOG_ID.slice(0, 10));
        await page.keyboard.press("Escape");

        await page.locator("#settings-btn").click();
        await page.locator("#settings-date-format-select").selectOption("locale");
        await page.locator("#settings-modal-close").click();
        await page.locator("#whats-new-btn").click();
        await expect(heading).toHaveText(localizedDate, { useInnerText: true });
    });
});

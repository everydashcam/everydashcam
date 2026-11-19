// The author’s note waits for returning use, yields to recording work, and
// remains available in About after automatic reminders stop.

import type { Page } from "@playwright/test";

import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    SAMPLE_GOPRO,
    SAMPLE_NOGPS,
    clearOnboarding,
    expect,
    gotoApp,
    presetLocalStorage,
    pausePlayback,
    setStoredPreference,
    shot,
    test,
} from "./_fixtures.js";

const FIRST_USE_AT = "everydashcam:support:first-use-at";
const LAST_SHOWN_AT = "everydashcam:support:last-shown-at";
const ACTION_TAKEN = "everydashcam:support:action-taken";
const MONTH_AND_A_DAY_MS = 31 * 24 * 60 * 60 * 1000;

async function armIngestCounter(page: Page): Promise<void> {
    await page.evaluate(() => {
        const target = window as typeof window & { __supportIngestDoneCount?: number };
        target.__supportIngestDoneCount = 0;
        addEventListener("everydashcam:ingest-done", () => {
            target.__supportIngestDoneCount = (target.__supportIngestDoneCount ?? 0) + 1;
        });
    });
}

async function resetSupportState(page: Page, isReturning = false): Promise<void> {
    await setStoredPreference(page, FIRST_USE_AT, isReturning ? String(Date.now() - 2 * 24 * 60 * 60 * 1000) : null);
    await setStoredPreference(page, LAST_SHOWN_AT, null);
    await setStoredPreference(page, ACTION_TAKEN, null);
}

async function loadAndWait(page: Page, directory: string): Promise<void> {
    const before = await page.evaluate(
        () => (window as typeof window & { __supportIngestDoneCount?: number }).__supportIngestDoneCount ?? 0,
    );
    await page.locator("#folder-input").setInputFiles(directory);
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (window as typeof window & { __supportIngestDoneCount?: number }).__supportIngestDoneCount ?? 0,
                ),
            { timeout: 30_000 },
        )
        .toBe(before + 1);
}

test.describe("project support prompt", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
    });

    test("waits for returning use and repeats only after a month and another useful load", async ({ page }) => {
        await gotoApp(page, "en");
        await resetSupportState(page);
        await armIngestCounter(page);
        const banner = page.locator("#support-banner");

        await loadAndWait(page, SAMPLE_70MAI);
        const firstUseAt = Number(await page.evaluate((key) => localStorage.getItem(key), FIRST_USE_AT));
        expect(firstUseAt).toBeGreaterThan(Date.now() - 10_000);
        await loadAndWait(page, SAMPLE_70MAI);
        await loadAndWait(page, SAMPLE_GOPRO);
        expect(Number(await page.evaluate((key) => localStorage.getItem(key), FIRST_USE_AT))).toBe(firstUseAt);
        await expect(banner).toBeHidden();

        // A reload and more recordings on the same day are still too early.
        await gotoApp(page, "en");
        await setStoredPreference(page, ACTION_TAKEN, null);
        await armIngestCounter(page);
        await loadAndWait(page, SAMPLE_70MAI);
        await expect(banner).toBeHidden();

        await gotoApp(page, "en");
        await resetSupportState(page, true);
        await armIngestCounter(page);
        await expect(banner).toBeHidden();
        await loadAndWait(page, SAMPLE_70MAI);
        await expect(banner).toBeVisible();
        await expect(page.locator("#support-banner-title")).toHaveText("From the author");
        await expect(page.locator("#support-banner-body")).toContainText("wherever it fits");
        await expect(page.locator("#support-banner-github")).toHaveAttribute(
            "href",
            "https://github.com/everydashcam/everydashcam",
        );
        await expect(page.locator("#support-banner-copy")).toHaveText("Copy link");
        await expect(page.locator("#support-banner-close")).toHaveText("Close");
        const firstShownAt = Number(await page.evaluate((key) => localStorage.getItem(key), LAST_SHOWN_AT));
        expect(firstShownAt).toBeGreaterThan(Date.now() - 10_000);
        expect(await page.evaluate((key) => localStorage.getItem(key), ACTION_TAKEN)).toBeNull();
        await shot(page, "support-note-en-desktop");

        await page.locator("#support-banner-close").click();
        await loadAndWait(page, SAMPLE_GOPRO);
        await expect(banner).toBeHidden();

        await setStoredPreference(page, LAST_SHOWN_AT, String(Date.now() - MONTH_AND_A_DAY_MS));
        // Duplicates and unrelated interactions cannot trigger a reminder.
        await loadAndWait(page, SAMPLE_GOPRO);
        await page.locator("#settings-btn").click();
        await page.locator("#settings-modal-header-close").click();
        await expect(banner).toBeHidden();
        await loadAndWait(page, SAMPLE_NOGPS);
        await expect(banner).toBeVisible();
        expect(Number(await page.evaluate((key) => localStorage.getItem(key), LAST_SHOWN_AT))).toBeGreaterThan(
            firstShownAt,
        );
    });

    test("waits for onboarding and playback without requiring another load", async ({ page }) => {
        // The loaded card is multi-camera, but its conditional tour has not yet
        // been offered. It must not become a permanent gate behind the player
        // tour that wins this first trip-open seam.
        await clearOnboarding(page);
        await gotoApp(page, "en");
        await resetSupportState(page, true);
        await armIngestCounter(page);

        await loadAndWait(page, SAMPLE_70MAI);
        await expect(page.locator(".dc-onb")).toBeVisible({ timeout: 5_000 });
        await page.locator(".dc-onb__next").click();
        await expect(page.locator(".dc-onb")).toHaveCount(0);

        await loadAndWait(page, SAMPLE_GOPRO);
        await expect(page.locator("#support-banner")).toBeHidden();

        // Once the core tour has reached the user, the already-earned prompt
        // retries by itself. No third recording load is required.
        await page.locator("li.trip:not(.unindexed-note)").first().click();
        await expect(page.locator(".dc-onb")).toBeVisible({ timeout: 5_000 });
        await page.locator(".dc-onb__x").click();
        await expect(page.locator(".dc-onb")).toHaveCount(0);
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
        await expect(page.locator("#support-banner")).toBeHidden();
        await pausePlayback(page);
        await expect(page.locator("#support-banner")).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("everydashcam:onboarding:player"))).toBeNull();
        expect(
            await page.evaluate(
                () => (window as typeof window & { __supportIngestDoneCount?: number }).__supportIngestDoneCount,
            ),
        ).toBe(2);
    });

    test("keeps an earned prompt pending until a competing banner leaves", async ({ page }) => {
        await gotoApp(page, "en");
        await resetSupportState(page, true);
        await armIngestCounter(page);

        await page.evaluate(() => {
            const installBanner = document.getElementById("install-banner");
            if (installBanner) installBanner.hidden = false;
        });
        await loadAndWait(page, SAMPLE_GOPRO);
        await expect(page.locator("#support-banner")).toBeHidden();

        // Programmatic teardown exercises the release observer rather than the
        // generic user-interaction fallback.
        await page.evaluate(() => {
            const installBanner = document.getElementById("install-banner");
            if (installBanner) installBanner.hidden = true;
        });
        await expect(page.locator("#support-banner")).toBeVisible();
    });

    test("preserves earlier cooldowns and stops reminders after a GitHub visit", async ({ page }) => {
        await gotoApp(page, "en");
        await resetSupportState(page);
        await setStoredPreference(page, LAST_SHOWN_AT, String(Date.now()));
        await armIngestCounter(page);
        await loadAndWait(page, SAMPLE_70MAI);
        const banner = page.locator("#support-banner");
        await expect(banner).toBeHidden();
        await setStoredPreference(page, LAST_SHOWN_AT, String(Date.now() - MONTH_AND_A_DAY_MS));
        await loadAndWait(page, SAMPLE_GOPRO);
        await expect(banner).toBeVisible();
        await page.context().route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "" }));
        const popupPromise = page.waitForEvent("popup");
        await page.locator("#support-banner-github").click();
        const popup = await popupPromise;
        await popup.close();
        await expect(banner).toBeHidden();
        expect(await page.evaluate((key) => localStorage.getItem(key), ACTION_TAKEN)).toBe("1");
        await setStoredPreference(page, LAST_SHOWN_AT, String(Date.now() - MONTH_AND_A_DAY_MS));
        await loadAndWait(page, SAMPLE_NOGPS);
        await expect(banner).toBeHidden();
    });

    test("keeps the note in About after a support action and recovers from a failed copy", async ({ page }) => {
        await gotoApp(page, "en");
        // The default fixture represents someone who already supported the project.
        await page.locator("#settings-btn").click();
        const note = page.locator("#settings-support-note");
        await note.locator("summary").click();
        await expect(note).toContainText("Recommendations like these mean a lot to me");
        await expect(note.locator(".support-github")).toHaveAttribute(
            "href",
            "https://github.com/everydashcam/everydashcam",
        );
        await setStoredPreference(page, ACTION_TAKEN, null);
        await page.evaluate(() => {
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: { writeText: () => Promise.reject(new Error("clipboard blocked")) },
            });
            document.execCommand = () => false;
        });
        const copy = note.locator(".support-copy");
        await copy.click();
        await expect(copy).toHaveText("Couldn't copy the link");
        expect(await page.evaluate((key) => localStorage.getItem(key), ACTION_TAKEN)).toBeNull();
        await expect(copy).toHaveText("Copy link");
        await page.locator("#settings-modal-header-close").click();
        await resetSupportState(page, true);
        await armIngestCounter(page);
        await loadAndWait(page, SAMPLE_70MAI);
        await expect(page.locator("#support-banner")).toBeVisible();
        await page.locator("#settings-btn").click();
        await page.evaluate(() => {
            const target = window as typeof window & { __supportCopiedUrl?: string };
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                    writeText: (url: string) => {
                        target.__supportCopiedUrl = url;
                        return Promise.resolve();
                    },
                },
            });
        });
        await copy.click();
        await expect(copy).toHaveText("Link copied");
        expect(
            await page.evaluate(() => (window as typeof window & { __supportCopiedUrl?: string }).__supportCopiedUrl),
        ).toBe("https://everydashcam.app/en/");
        expect(await page.evaluate((key) => localStorage.getItem(key), ACTION_TAKEN)).toBe("1");
        await expect(copy).toHaveText("Copy link");
        await expect(page.locator("#settings-modal")).toBeVisible();
        await expect(note).toHaveAttribute("open", "");
        await shot(page, "support-note-about-en");
        await page.locator("#settings-modal-header-close").click();
        await expect(page.locator("#support-banner")).toBeHidden();
    });

    test("feedback opens with a thank-you before asking for recordings", async ({ page }) => {
        await gotoApp(page, "en");
        await page.locator("#feedback-btn").click();

        await expect(page.locator("#feedback-modal")).toBeVisible();
        await expect(page.locator(".feedback-thanks")).toHaveText(
            "Thanks for taking the time to write — it really helps make everydashcam better.",
        );
        const order = await page
            .locator("#feedback-step-recordings")
            .evaluate((step) => Array.from(step.children).map((child) => child.className));
        expect(order[0]).toContain("feedback-thanks");
    });

    test("fits the Russian actions on a light-theme mobile viewport", async ({ page }) => {
        await gotoApp(page, "ru");
        await resetSupportState(page, true);
        // The test browser speaks English, so /ru/ correctly surfaces the
        // language suggestion. It has priority over this nudge; dismiss it
        // before exercising the support banner itself.
        await page.locator(".lang-banner-dismiss").click();
        await page.locator('.theme-toggle-btn[data-theme="light"]').click();
        await page.setViewportSize(MOBILE);
        await page.evaluate(() => {
            const target = window as typeof window & { __supportCopiedUrl?: string };
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                    writeText: (text: string) => {
                        target.__supportCopiedUrl = text;
                        return Promise.resolve();
                    },
                },
            });
        });
        await armIngestCounter(page);
        await loadAndWait(page, SAMPLE_GOPRO);

        const banner = page.locator("#support-banner");
        await expect(banner).toBeVisible();
        await expect(page.locator("html")).toHaveClass(/dc-light/);
        await expect(page.locator("#support-banner-title")).toHaveText("От автора");
        await expect(page.locator("#support-banner-github")).toHaveText("Звезде на GitHub тоже буду рад.");
        await expect(page.locator("#support-banner-copy")).toHaveText("Скопировать ссылку");
        await expect(page.locator("#support-banner-close")).toHaveText("Закрыть");

        // The entrance translation can temporarily put the banner below the viewport.
        await expect(banner).toHaveCSS("transform", "none");
        const layout = await banner.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const actions = Array.from(element.querySelectorAll<HTMLElement>(".support-note-actions .dc-btn")).map(
                (button) => {
                    const box = button.getBoundingClientRect();
                    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
                },
            );
            return {
                viewport: { width: innerWidth, height: innerHeight },
                banner: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                overflowsHorizontally: element.scrollWidth > element.clientWidth,
                actions,
            };
        });
        expect(layout.banner.left).toBeGreaterThanOrEqual(0);
        expect(layout.banner.right).toBeLessThanOrEqual(layout.viewport.width);
        expect(layout.banner.top).toBeGreaterThanOrEqual(0);
        expect(layout.banner.bottom).toBeLessThanOrEqual(layout.viewport.height);
        expect(layout.overflowsHorizontally).toBe(false);
        expect(layout.actions).toHaveLength(2);
        for (const action of layout.actions) {
            expect(action.left).toBeGreaterThanOrEqual(layout.banner.left);
            expect(action.right).toBeLessThanOrEqual(layout.banner.right);
        }
        for (let i = 0; i < layout.actions.length; i++) {
            for (let j = i + 1; j < layout.actions.length; j++) {
                const first = layout.actions[i];
                const second = layout.actions[j];
                expect(first).toBeDefined();
                expect(second).toBeDefined();
                const overlap =
                    first !== undefined &&
                    second !== undefined &&
                    first.left < second.right &&
                    first.right > second.left &&
                    first.top < second.bottom &&
                    first.bottom > second.top;
                expect(overlap).toBe(false);
            }
        }

        await page.setViewportSize({ width: 320, height: 568 });
        const compactBounds = await banner.boundingBox();
        expect(compactBounds).not.toBeNull();
        expect(compactBounds!.x + compactBounds!.width).toBeLessThanOrEqual(320);
        expect(compactBounds!.y).toBeGreaterThanOrEqual(0);
        expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(568);
        expect(await banner.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
        await shot(page, "support-note-ru-mobile");
        await page.locator("#support-banner-copy").click();
        await expect(page.locator("#support-banner-copy")).toHaveText("Ссылка скопирована");
        expect(
            await page.evaluate(
                () => (window as typeof window & { __supportCopiedUrl?: string }).__supportCopiedUrl ?? null,
            ),
        ).toBe("https://everydashcam.app/ru/");
        expect(await page.evaluate((key) => localStorage.getItem(key), ACTION_TAKEN)).toBe("1");
        await expect(banner).toBeHidden({ timeout: 3_000 });

        // Sharing is a completed action: even an expired display timestamp and
        // another useful load must not revive the prompt.
        await setStoredPreference(page, LAST_SHOWN_AT, String(Date.now() - MONTH_AND_A_DAY_MS));
        await loadAndWait(page, SAMPLE_NOGPS);
        await expect(banner).toBeHidden();
    });
});

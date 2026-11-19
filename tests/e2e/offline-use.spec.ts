import type { Page } from "@playwright/test";
import { DESKTOP, MOBILE, expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

interface InstallProbeWindow extends Window {
    __offlineUsePromptCount: number;
}

interface PendingPromptWindow extends InstallProbeWindow {
    __offlineUseResolvePrompt: () => void;
    __offlineUseChoiceReads: number;
}

interface RelatedAppsProbeWindow extends Window {
    __offlineUseRelatedApps?: () => Promise<{ platform: string }[]>;
    __offlineUseResolveRelatedApps: (apps: { platform: string }[]) => void;
    __offlineUseRelatedAppsQueries: number;
}

async function captureInstallPrompt(page: Page, outcome: "accepted" | "dismissed", errorName?: string): Promise<void> {
    await page.evaluate(
        ({ choice, rejection }) => {
            const probe = window as unknown as InstallProbeWindow;
            probe.__offlineUsePromptCount = 0;
            const event = new Event("beforeinstallprompt", { cancelable: true });
            Object.defineProperties(event, {
                platforms: { value: ["web"] },
                prompt: {
                    value: async () => {
                        probe.__offlineUsePromptCount++;
                        if (rejection) throw new DOMException("native install service is unavailable", rejection);
                    },
                },
                userChoice: { value: Promise.resolve({ outcome: choice, platform: "web" }) },
            });
            dispatchEvent(event);
        },
        { choice: outcome, rejection: errorName },
    );
}

async function promptCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as InstallProbeWindow).__offlineUsePromptCount);
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "getInstalledRelatedApps", {
            configurable: true,
            get: () => (window as unknown as RelatedAppsProbeWindow).__offlineUseRelatedApps,
        });
        // Drive browser installability explicitly; its timing depends on the
        // browser's engagement history and service-worker registration.
        addEventListener(
            "beforeinstallprompt",
            (event) => {
                if (!event.isTrusted) return;
                event.preventDefault();
                event.stopImmediatePropagation();
            },
            true,
        );
    });
});

test("opens the offline chooser without an empty file section and restores focus on close", async ({ page }) => {
    await gotoApp(page);
    const entry = page.locator("#offline-use-btn");
    const modal = page.locator("#offline-use-modal");
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await expect(modal.locator("#offline-use-file")).toBeHidden();
    await expect(page.locator("#portable-download")).toHaveCount(0);
    await page.locator("#offline-use-close").click();
    await expect(modal).toBeHidden();
    await expect(entry).toBeFocused();

    await entry.click();
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(entry).toBeFocused();
});

test("hands off to the installation guide when no native prompt is available", async ({ page }) => {
    await gotoApp(page);
    const entry = page.locator("#offline-use-btn");
    const modal = page.locator("#offline-use-modal");
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await modal.locator("#install-btn").click();
    await expect(modal).toBeHidden();
    await expect(page.locator("#install-modal")).toBeVisible();
    await expect(page.locator("#install-modal-body")).not.toHaveText("");
    await page.locator("#install-modal-close").click();
    await expect(page.locator("#install-modal")).toBeHidden();
    await expect(entry).toBeFocused();
});

test("opens the installation guide while the OS installation query is pending", async ({ page }) => {
    await page.addInitScript(() => {
        const probe = window as unknown as RelatedAppsProbeWindow;
        probe.__offlineUseRelatedApps = () =>
            new Promise((resolve) => {
                probe.__offlineUseResolveRelatedApps = resolve;
            });
    });
    await gotoApp(page);
    const entry = page.locator("#offline-use-btn");
    await entry.click();
    await expect(page.locator("#offline-use-modal")).toHaveAttribute("data-install-state", "guide");
    await page.locator("#install-btn").click();
    await expect(page.locator("#offline-use-modal")).toBeHidden();
    await expect(page.locator("#install-modal")).toBeVisible();
    await page.locator("#install-modal-close").click();
    await expect(entry).toBeFocused();

    await page.evaluate(() => (window as unknown as RelatedAppsProbeWindow).__offlineUseResolveRelatedApps([]));
    await expect(page.locator("#install-modal")).toBeHidden();
});

test("preserves an installed signal when the OS installation query fails", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("everydashcam:pwa:installed", "1");
        const probe = window as unknown as RelatedAppsProbeWindow;
        probe.__offlineUseRelatedApps = () => Promise.reject(new Error("installation service is unavailable"));
    });
    await gotoApp(page);
    await page.locator("#offline-use-btn").click();
    const modal = page.locator("#offline-use-modal");
    await expect(modal).toHaveAttribute("data-install-state", "installed");
    await expect(modal.locator("#install-btn")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:pwa:installed"))).toBe("1");
});

test("clears an installed signal when the OS confirms the app is absent", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("everydashcam:pwa:installed", "1");
        const probe = window as unknown as RelatedAppsProbeWindow;
        probe.__offlineUseRelatedApps = async () => [];
    });
    await gotoApp(page);
    await page.locator("#offline-use-btn").click();
    const modal = page.locator("#offline-use-modal");
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await expect(modal.locator("#install-btn")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:pwa:installed"))).toBeNull();
});

test("consumes a dismissed native prompt once and offers the guide on the next visit", async ({ page }) => {
    await gotoApp(page);
    await captureInstallPrompt(page, "dismissed");
    const entry = page.locator("#offline-use-btn");
    const modal = page.locator("#offline-use-modal");
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "install");
    await modal.locator("#install-btn").click();
    await expect.poll(() => promptCount(page)).toBe(1);

    await page.keyboard.press("Escape");
    await entry.click();
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await modal.locator("#install-btn").click();
    await expect(page.locator("#install-modal")).toBeVisible();
    expect(await promptCount(page)).toBe(1);
});

test("offers installation guidance after InvalidStateError without recording an installation", async ({ page }) => {
    await gotoApp(page);
    await captureInstallPrompt(page, "dismissed", "InvalidStateError");
    const entry = page.locator("#offline-use-btn");
    const modal = page.locator("#offline-use-modal");
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "install");
    await modal.locator("#install-btn").click();
    await expect(modal).toBeHidden();
    await expect(page.locator("#install-modal")).toBeVisible();
    await expect(page.locator("#install-modal-title")).toHaveText("Install as a desktop app");
    expect(await promptCount(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:pwa:installed"))).toBeNull();

    await page.locator("#install-modal-close").click();
    await expect(entry).toBeFocused();
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await expect(modal.locator("#install-btn")).toBeVisible();
    await expect(modal.locator("#offline-use-app-status")).toBeHidden();
});

test("shows the installed state after native acceptance and appinstalled", async ({ page }) => {
    await gotoApp(page);
    await captureInstallPrompt(page, "accepted");
    const entry = page.locator("#offline-use-btn");
    const modal = page.locator("#offline-use-modal");
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "install");
    await modal.locator("#install-btn").click();
    await expect.poll(() => promptCount(page)).toBe(1);
    await expect(modal).toBeHidden();
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await page.evaluate(() => dispatchEvent(new Event("appinstalled")));
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "installed");
    await expect(modal.locator("#install-btn")).toBeHidden();
    await expect(modal.locator("#offline-use-app-status")).toBeVisible();
    expect(await promptCount(page)).toBe(1);
    await page.locator("#offline-use-close").click();
    await expect(entry).toBeFocused();
});

test("finishes native installation when appinstalled fires before prompt resolves", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
        const probe = window as unknown as PendingPromptWindow;
        probe.__offlineUsePromptCount = 0;
        probe.__offlineUseChoiceReads = 0;
        const pendingPrompt = new Promise<void>((resolve) => {
            probe.__offlineUseResolvePrompt = resolve;
        });
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.defineProperties(event, {
            platforms: { value: ["web"] },
            prompt: {
                value: () => {
                    probe.__offlineUsePromptCount++;
                    dispatchEvent(new Event("appinstalled"));
                    return pendingPrompt;
                },
            },
            userChoice: {
                get: () => {
                    probe.__offlineUseChoiceReads++;
                    return Promise.resolve({ outcome: "accepted", platform: "web" });
                },
            },
        });
        dispatchEvent(event);
    });
    const entry = page.locator("#offline-use-btn");
    const modal = page.locator("#offline-use-modal");
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "install");
    await modal.locator("#install-btn").click();
    await expect.poll(() => promptCount(page)).toBe(1);
    await entry.click();
    await expect(modal).toHaveAttribute("data-install-state", "installed");
    await expect(modal.locator("#install-btn")).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as PendingPromptWindow).__offlineUseChoiceReads)).toBe(0);

    await page.evaluate(() => (window as unknown as PendingPromptWindow).__offlineUseResolvePrompt());
    await expect
        .poll(() => page.evaluate(() => (window as unknown as PendingPromptWindow).__offlineUseChoiceReads))
        .toBe(1);
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "installed");
    await expect(page.locator("#install-modal")).toBeHidden();
    expect(await promptCount(page)).toBe(1);
});

test("preserves a confirmed installation when an earlier OS query returns no installed apps", async ({ page }) => {
    await page.addInitScript(() => {
        const probe = window as unknown as RelatedAppsProbeWindow;
        probe.__offlineUseRelatedAppsQueries = 0;
        probe.__offlineUseRelatedApps = () => {
            probe.__offlineUseRelatedAppsQueries++;
            return new Promise((resolve) => {
                probe.__offlineUseResolveRelatedApps = resolve;
            });
        };
    });
    await gotoApp(page);
    await expect
        .poll(() => page.evaluate(() => (window as unknown as RelatedAppsProbeWindow).__offlineUseRelatedAppsQueries))
        .toBe(1);
    await page.locator("#offline-use-btn").click();
    const modal = page.locator("#offline-use-modal");
    await expect(modal).toHaveAttribute("data-install-state", "guide");
    await page.evaluate(() => dispatchEvent(new Event("appinstalled")));
    await expect(modal).toHaveAttribute("data-install-state", "installed");

    await page.evaluate(async () => {
        (window as unknown as RelatedAppsProbeWindow).__offlineUseResolveRelatedApps([]);
        // Let the OS query's promise reactions settle before checking the UI.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "installed");
    await expect(modal.locator("#install-btn")).toBeHidden();
    await expect(modal.locator("#offline-use-app-status")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:pwa:installed"))).toBe("1");
});

test("keeps the offline chooser available inside an installed standalone app", async ({ page }) => {
    await page.addInitScript(() => {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
            const result = original(query);
            if (query === "(display-mode: standalone)") {
                Object.defineProperty(result, "matches", { value: true });
            }
            return result;
        };
    });
    await gotoApp(page);
    const entry = page.locator("#offline-use-btn");
    await expect(entry).toBeVisible();
    await entry.click();
    const modal = page.locator("#offline-use-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "installed");
    await expect(modal.locator("#install-btn")).toBeHidden();
    await expect(modal.locator("#offline-use-app-status")).toBeVisible();
    await expect(modal.locator("#offline-use-app-status")).not.toHaveText("");
    await page.locator("#offline-use-close").click();
    await expect(entry).toBeFocused();
});

test("explains unsupported installation while keeping the offline entry available", async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "userAgent", {
            configurable: true,
            value: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
        });
        Object.defineProperty(navigator, "userAgentData", { configurable: true, value: undefined });
    });
    await gotoApp(page);
    await page.locator("#offline-use-btn").click();
    const modal = page.locator("#offline-use-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("data-install-state", "unsupported");
    await expect(modal.locator("#install-btn")).toBeHidden();
    await expect(modal.locator("#offline-use-file")).toBeHidden();
    await page.locator("#offline-use-close").click();
    await expect(page.locator("#offline-use-btn")).toBeFocused();
});

test.describe("touch header", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("keeps offline use ahead of theme and opens the same chooser from overflow", async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await gotoApp(page);
        await expect(page.locator(".theme-toggle")).toBeHidden();
        await expect(page.locator("#offline-use-btn")).toBeVisible();
        await page.setViewportSize({ width: 320, height: 568 });
        await expect(page.locator("#offline-use-btn")).toHaveAttribute("data-overflow-hidden", "true");
        await page.locator("#topbar-overflow").click();
        await page.locator("#topbar-overflow-menu").getByRole("menuitem", { name: "Use offline", exact: true }).click();
        await expect(page.locator("#offline-use-modal")).toBeVisible();
        await expect(page.locator("#topbar-overflow-menu")).toBeHidden();
        await expect(page.locator("#offline-use-file")).toBeHidden();
        await page.locator("#offline-use-close").click();
        await expect(page.locator("#offline-use-modal")).toBeHidden();
        await expect(page.locator("#topbar-overflow")).toBeFocused();
    });
});

import { type Page, expect } from "@playwright/test";
import { loadTrip, pausePlayback } from "./_fixtures.js";

export async function verifyModalIsolation(page: Page): Promise<void> {
    await page.evaluate(() => {
        const sentinel = document.createElement("button");
        sentinel.id = "preexisting-inert";
        sentinel.inert = true;
        document.body.append(sentinel);
    });
    await page.locator("#settings-btn").click();
    const settings = page.locator("#settings-modal");
    await expect(settings).toBeVisible();
    await settings.evaluate((element) => {
        // Exercise native Tab ordering inside the real modal manager without
        // coupling the regression to the current list of settings controls.
        const card = element.querySelector<HTMLElement>(".export-modal-card")!;
        for (const child of card.children) if (child instanceof HTMLElement) child.inert = true;
        const controls = document.createElement("div");
        controls.innerHTML = `
            <button id="priority-second" tabindex="2">Second priority</button>
            <button id="priority-first" tabindex="1">First priority</button>
            <input type="radio" name="focus-regression" id="radio-unselected">
            <input type="radio" name="focus-regression" id="radio-selected" checked>
            <details><summary id="focus-summary">Details</summary><button>Hidden</button></details>
            <fieldset disabled><button id="disabled-fieldset">Disabled</button></fieldset>
            <button id="last-tab-stop">Last</button>
            <button id="programmatic-only" tabindex="-1">Programmatic only</button>`;
        card.append(controls);
        const background = document.createElement("button");
        background.id = "late-background";
        document.body.append(background);
    });
    await expect.poll(() => page.locator("#late-background").evaluate((el) => !!el.closest("[inert]"))).toBe(true);
    await page.locator("#last-tab-stop").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#priority-first")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#last-tab-stop")).toBeFocused();
    await page.locator("#priority-second").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#radio-selected")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#focus-summary")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#last-tab-stop")).toBeFocused();

    // An asynchronous foreground dialog can arrive while settings is open.
    // Its lower dialog may finish first, so dismissal cannot assume LIFO order.
    await page.locator("#player-help").evaluate((button: HTMLElement) => button.click());
    const help = page.locator("#hotkeys-modal");
    await expect(help).toBeVisible();
    await expect(help).toBeFocused();
    await expect(settings).toHaveAttribute("inert", "");
    await page.locator("#settings-modal-header-close").evaluate((button: HTMLElement) => button.click());
    await expect(settings).toBeHidden();
    await expect(help).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(page.locator("#settings-btn")).toBeFocused();
    await expect(page.locator("#preexisting-inert")).toHaveAttribute("inert", "");
    await expect(page.locator("#late-background")).not.toHaveAttribute("inert");
}

export async function verifyPopoverOwnership(page: Page, secondaryMenu = "#lang-toggle"): Promise<void> {
    await loadTrip(page);
    await pausePlayback(page);
    const speed = page.locator("#player-speed");
    const otherMenu = page.locator(secondaryMenu);
    await speed.click();
    await expect(speed).toHaveAttribute("aria-expanded", "true");
    // Programmatic activation has no outside pointer event; opening itself
    // must release the old menu's ownership.
    await otherMenu.evaluate((button: HTMLElement) => button.click());
    await expect(speed).toHaveAttribute("aria-expanded", "false");
    await expect(otherMenu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(otherMenu).toHaveAttribute("aria-expanded", "false");
    await expect(otherMenu).toBeFocused();
    await speed.focus();
    await page.keyboard.press("ArrowDown");
    await expect(speed).toHaveAttribute("aria-expanded", "true");
    await page.locator("#settings-btn").click();
    await expect(speed).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#settings-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-btn")).toBeFocused();
}

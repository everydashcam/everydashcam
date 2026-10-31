import { type Page, expect } from "@playwright/test";
import { loadTrip, pausePlayback } from "./_fixtures.js";

const FOCUS_CONTROLS = `
    <button id="priority-second" tabindex="2">Second priority</button>
    <button id="priority-first" tabindex="1">First priority</button>
    <input type="radio" name="focus-regression" id="radio-unselected">
    <input type="radio" name="focus-regression" id="radio-selected" checked>
    <details><summary id="focus-summary">Details</summary><button>Hidden</button></details>
    <fieldset disabled><button id="disabled-fieldset">Disabled</button></fieldset>
    <button id="ordinary-button">Ordinary button</button>
    <input id="last-tab-stop" aria-label="Last">
    <button id="programmatic-only" tabindex="-1">Programmatic only</button>`;

async function nativeTabOrder(page: Page): Promise<string[]> {
    // macOS keyboard preferences can exclude ordinary buttons and radio groups
    // from Tab. Measure the same engine's order outside the application, with
    // a text input as the last stop under either keyboard preference.
    const reference = await page.context().newPage();
    try {
        await reference.setContent(FOCUS_CONTROLS);
        await reference.locator("#priority-first").focus();
        const order = ["priority-first"];
        for (let step = 0; step < 10; step++) {
            await reference.keyboard.press("Tab");
            const id = await reference.evaluate(() => document.activeElement?.id ?? "");
            expect(id, "native focus stays within the reference controls").not.toBe("");
            expect(order, "native Tab reaches the final text input before repeating").not.toContain(id);
            order.push(id);
            if (id === "last-tab-stop") return order;
        }
        throw new Error("native Tab did not reach the reference's final control");
    } finally {
        await reference.close();
        await page.bringToFront();
    }
}

export async function verifyModalIsolation(page: Page): Promise<void> {
    const expectedOrder = await nativeTabOrder(page);
    await page.evaluate(() => {
        const sentinel = document.createElement("button");
        sentinel.id = "preexisting-inert";
        sentinel.inert = true;
        document.body.append(sentinel);
    });
    await page.locator("#settings-btn").click();
    const settings = page.locator("#settings-modal");
    await expect(settings).toBeVisible();
    await settings.evaluate((element, markup) => {
        // Exercise native Tab ordering inside the real modal manager without
        // coupling the regression to the current list of settings controls.
        const card = element.querySelector<HTMLElement>(".export-modal-card")!;
        for (const child of card.children) if (child instanceof HTMLElement) child.inert = true;
        const controls = document.createElement("div");
        controls.innerHTML = markup;
        card.append(controls);
        const background = document.createElement("button");
        background.id = "late-background";
        document.body.append(background);
    }, FOCUS_CONTROLS);
    await expect.poll(() => page.locator("#late-background").evaluate((el) => !!el.closest("[inert]"))).toBe(true);
    await page.locator("#last-tab-stop").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#priority-first")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#last-tab-stop")).toBeFocused();
    await page.locator("#priority-first").focus();
    for (const id of expectedOrder.slice(1)) {
        await page.keyboard.press("Tab");
        await expect(page.locator(`#${id}`)).toBeFocused();
    }

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

    // Reset confirmation replaces settings. Returning by either dismissal
    // route must preserve the original visible opener for the final close.
    for (const dismiss of ["cancel", "escape"] as const) {
        await page.locator("#settings-btn").click();
        await page.locator("#settings-reset-btn").click();
        await expect(page.locator("#settings-modal")).toBeHidden();
        await expect(page.locator("#reset-confirm-cancel")).toBeFocused();
        if (dismiss === "cancel") await page.locator("#reset-confirm-cancel").click();
        else await page.keyboard.press("Escape");
        await expect(page.locator("#reset-confirm-modal")).toBeHidden();
        await expect(page.locator("#settings-modal-header-close")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#settings-btn")).toBeFocused();
    }
}

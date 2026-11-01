import { type Page, expect } from "@playwright/test";

import { waitForMetadata } from "./_fixtures.js";

/** Compact row controls follow the desktop sidebar's visibility in both directions. */
export async function checkCollapsedCompactTripActions(page: Page): Promise<void> {
    await page.locator('#trip-density [data-density="rows"]').click();
    const card = page.locator("li.trip").first();
    await card.locator(".trip-chevron").click();
    const favorite = card.locator(".trip-fav");
    await expect(favorite).toBeVisible();

    const toggle = page.locator("#sidebar-toggle");
    await toggle.click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await toggle.focus();
    await favorite.evaluate((button: HTMLButtonElement) => button.focus());
    await expect(toggle, "hidden row actions cannot take keyboard focus").toBeFocused();
    await expect(favorite).toBeHidden();

    await toggle.click();
    await expect(favorite).toBeVisible();
    await favorite.focus();
    await expect(favorite).toBeFocused();
}

/**
 * Checks that the card's corner buttons own their centers and edges, that an
 * edge activation reaches the button instead of opening the trip, and that a
 * press at the event chip's edge keeps the chip under the pointer. `touch`
 * activates the buttons with taps; Playwright has no touch hold, so the chip
 * press is held with the mouse in both modes.
 */
export async function checkTripCardActions(page: Page, input: "mouse" | "touch" = "mouse"): Promise<void> {
    const card = page.locator("li.trip:not(.unindexed-note)").first();
    await expect(card).toBeVisible();
    await expect(page.locator("#ingest-overlay")).toBeHidden();
    await expect(page.locator("#trip-analysis-status")).toBeHidden();
    await waitForMetadata(page);
    // Public samples have no impacts; use the same event seam as trip-events.spec.ts.
    await page.evaluate(() => {
        const trip = window.__everydashcam.state.trips[0]!;
        trip.events = [1, 2, 3].map((relSec) => ({
            kind: "brake",
            unixSeconds: trip.startUtc + relSec,
            relSec,
            severity: 0.42,
            recordIndex: 0,
        }));
    });
    await page.locator("#trip-sort-key").selectOption("duration");
    await card.scrollIntoViewIfNeeded();
    // Every trip open marks its card synchronously on click, while the player
    // state only follows the async read, so a stray open is caught here.
    await page.evaluate(() => {
        const list = document.getElementById("trip-list")!;
        new MutationObserver((records) => {
            if (records.some((record) => (record.target as Element).classList.contains("trip--opening"))) {
                list.dataset.testTripOpened = "true";
            }
        }).observe(list, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
    const tripList = page.locator("#trip-list");
    const expectTripNotOpened = async (message: string): Promise<void> => {
        await expect(tripList, message).not.toHaveAttribute("data-test-trip-opened");
        expect(await page.evaluate(() => window.__everydashcam.state.active), message).toBeNull();
    };
    const activateEdge = async (selector: string, side: "left" | "right"): Promise<void> => {
        const box = (await card.locator(selector).boundingBox())!;
        const x = side === "left" ? box.x + 1 : box.x + box.width - 1;
        const y = box.y + box.height / 2;
        if (input === "touch") await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
    };

    for (const action of ["trip-fav", "trip-edit", "chevron", "trip-events"]) {
        const control = card.locator(`[data-action="${action}"]`);
        const owners = await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            return [
                [cx, cy],
                [box.left + 1, cy],
                [box.right - 1, cy],
                [cx, box.top + 1],
                [cx, box.bottom - 1],
            ].map(([x, y]) => document.elementFromPoint(x!, y!)?.closest<HTMLElement>("[data-action]")?.dataset.action);
        });
        expect(owners, `${action} owns its center and all four edges`).toEqual(Array(5).fill(action));
    }

    if (input === "mouse") {
        const header = card.locator(".trip-header");
        const veilOpacity = () => header.evaluate((element) => getComputedStyle(element, "::after").opacity);
        await card.locator(".trip-title").hover();
        await expect.poll(veilOpacity, "hovering the card body lights the card").not.toBe("0");
        await card.locator(".trip-fav").hover();
        await expect.poll(veilOpacity, "hovering a corner button leaves the card unlit").toBe("0");
    }

    await activateEdge(".trip-chevron", "left");
    await expect(card).toHaveClass(/expanded/);
    await expectTripNotOpened("the chevron edge only expands the card");
    await activateEdge(".trip-chevron", "right");
    await expect(card).not.toHaveClass(/expanded/);

    await activateEdge(".trip-fav", "left");
    await expect(card.locator(".trip-fav")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#notes-storage-browser").click();
    await expect(page.locator("#notes-storage-modal")).toBeHidden();
    await activateEdge(".trip-edit", "right");
    await expect(page.locator("#trip-meta-modal")).toBeVisible();
    await page.locator("#trip-meta-cancel").click();
    await expectTripNotOpened("the star and pencil edges keep the trip closed");

    const chip = card.locator(".trip-event-chip");
    const chipSettled = () =>
        chip.evaluate((element) => element.getAnimations().every((animation) => animation.playState === "finished"));
    const chipBackground = () => chip.evaluate((element) => getComputedStyle(element).backgroundColor);
    const box = (await chip.boundingBox())!;
    const point = { x: box.x + 0.5, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => chip.evaluate((element) => element.matches(":hover"))).toBe(true);
    await expect.poll(chipSettled).toBe(true);
    const hoverBackground = await chipBackground();
    await page.mouse.down();
    try {
        await expect.poll(() => chip.evaluate((element) => element.matches(":active"))).toBe(true);
        await expect.poll(chipSettled).toBe(true);
        expect(await chipBackground(), "press feedback shows over the hover state").not.toBe(hoverBackground);
        expect(await chip.boundingBox(), "press feedback keeps the event shortcut's hit area stationary").toEqual(box);
        const owner = await page.evaluate(
            ({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-action]")?.dataset.action,
            point,
        );
        expect(owner, "pressing the edge keeps the event shortcut under the pointer").toBe("trip-events");
    } finally {
        await page.mouse.up();
    }
    await expect(card).toHaveClass(/active/);
}

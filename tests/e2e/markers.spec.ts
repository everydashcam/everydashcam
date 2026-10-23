// Timeline markers end to end: drop one from the player bar, then find, rename
// and delete it through the marker list. The list is the only surface that
// works on touch (a pin needs contextmenu), so it is the one under a gate.

import { DESKTOP, boxOf, expect, gotoApp, loadTrip, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";

const MASTER_VIDEO = ".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)";

/** Drops a marker and explicitly keeps notes in the browser when the first
 * completed write opens the mandatory app-wide storage decision. */
async function addMarker(page: import("@playwright/test").Page, text: string): Promise<void> {
    await page.locator("#player-add-marker").click();
    const modal = page.locator("#marker-modal");
    await expect(modal).toBeVisible();
    await page.locator("#marker-modal-text").fill(text);
    await page.locator("#marker-modal-save").click();
    await expect(modal).toBeHidden();
    const storage = page.locator("#notes-storage-modal");
    await expect(storage).toBeVisible();
    await storage.getByRole("button", { name: "Only in this browser" }).click();
    await expect(storage).toBeHidden();
}

/** The marker list is a secondary action and can move into More controls. */
async function openMarkerList(page: import("@playwright/test").Page): Promise<void> {
    const button = page.locator("#player-marker-list");
    await expect(button, "a trip with markers exposes the list action").toHaveJSProperty("hidden", false);
    if (await button.isVisible()) {
        await button.click();
    } else {
        await page.locator("#player-overflow").click();
        const action = page.locator("#player-overflow-menu").getByRole("button", { name: "Trip markers", exact: true });
        await expect(action).toBeVisible();
        await action.click();
    }
    await expect(page.locator("#marker-list-modal")).toBeVisible();
}

test.describe("timeline markers", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page);
    });

    test("the list action appears with the first marker and opens the trip's markers", async ({ page }) => {
        const listButton = page.locator("#player-marker-list");
        await expect(listButton, "no markers yet - the list action is unavailable").toHaveJSProperty("hidden", true);

        await addMarker(page, "checkpoint");
        await openMarkerList(page);

        const rows = page.locator("#marker-list-items .marker-list-row");
        await expect(rows).toHaveCount(1);
        await expect(rows.first().locator(".marker-list-text")).toHaveValue("checkpoint");
        await expect(page.locator("#marker-list-empty")).toBeHidden();
    });

    test("renaming in the list persists to the pin", async ({ page }) => {
        await addMarker(page, "before");
        await openMarkerList(page);

        const textInput = page.locator("#marker-list-items .marker-list-text").first();
        await textInput.fill("after");
        await textInput.press("Enter");
        await page.locator("#marker-list-close").click();
        await expect(page.locator("#marker-list-modal")).toBeHidden();

        // The pin carries the text as its accessible name - proof the edit went
        // through the store and not just the input's own value.
        await expect(page.locator(".timeline-marker-hit").first()).toHaveAttribute("aria-label", "after");
    });

    test("a list row seeks back to its moment and closes the modal", async ({ page }) => {
        // Paused first, so the geometry below measures seeks and not playback.
        await pausePlayback(page);
        // Asserted in pixels on the timeline, not on the bar's clock: the clock
        // is second-granular and the sample trip is a couple of seconds long,
        // so a text compare is satisfied by a seek that ignored the marker.
        // The pin and the playhead share the timeline host, so "the playhead
        // came back to the pin" is both precise and exactly what the user sees.
        const ruler = await boxOf(page, "#player-chart-ruler-top");
        await page.mouse.click(ruler.x + ruler.width * 0.25, ruler.y + ruler.height / 2);
        await addMarker(page, "start");
        // Centres, not left edges: the pin's hairline sits mid-box and the two
        // elements are different widths.
        const centreOf = async (selector: string): Promise<number> => {
            const box = await boxOf(page, selector);
            return box.x + box.width / 2;
        };
        const pinX = await centreOf(".timeline-marker");
        const playheadX = (): Promise<number> => centreOf("#player-chart-playhead");
        await expect
            .poll(async () => Math.abs((await playheadX()) - pinX), { message: "the pin is dropped at the playhead" })
            .toBeLessThan(4);

        // Away from the marker, then back through the list.
        await page.mouse.click(ruler.x + ruler.width * 0.85, ruler.y + ruler.height / 2);
        await expect
            .poll(async () => Math.abs((await playheadX()) - pinX), { message: "the away-seek must move the playhead" })
            .toBeGreaterThan(ruler.width * 0.2);

        await openMarkerList(page);
        await page.locator("#marker-list-items .marker-list-seek").first().click();
        // The backdrop hides the video, so a seek that left the modal open
        // would show the user nothing.
        await expect(page.locator("#marker-list-modal")).toBeHidden();
        await expect
            .poll(async () => Math.abs((await playheadX()) - pinX), { message: "the row must seek back to the pin" })
            .toBeLessThan(4);
    });

    test("dropping a marker holds the frame it names and hands playback back", async ({ page }) => {
        const isPaused = (): Promise<boolean> => page.locator(MASTER_VIDEO).evaluate((v: HTMLVideoElement) => v.paused);
        // Rewound before playing: the fixture trip is four seconds long, and a
        // run that starts near its end would report "paused" for having ended.
        await pausePlayback(page);
        const ruler = await boxOf(page, "#player-chart-ruler-top");
        await page.mouse.click(ruler.x + ruler.width * 0.1, ruler.y + ruler.height / 2);
        await page.locator("#player-play").click();
        await expect.poll(isPaused, { message: "the trip must be running first" }).toBe(false);

        await page.locator("#player-add-marker").click();
        await expect(page.locator("#marker-modal")).toBeVisible();
        await expect.poll(isPaused, { message: "the editor opens on a held frame" }).toBe(true);

        await page.locator("#marker-modal-save").click();
        await expect(page.locator("#marker-modal")).toBeHidden();
        const storage = page.locator("#notes-storage-modal");
        await expect(storage).toBeVisible();
        await storage.getByRole("button", { name: "Only in this browser" }).click();
        await expect(storage).toBeHidden();
        await expect.poll(isPaused, { message: "closing the editor resumes playback" }).toBe(false);
    });

    test("dropping a marker while paused leaves the player paused", async ({ page }) => {
        await pausePlayback(page);
        await addMarker(page, "still");
        await expect
            .poll(() => page.locator(MASTER_VIDEO).evaluate((v: HTMLVideoElement) => v.paused), {
                message: "a paused player must not start playing on its own",
            })
            .toBe(true);
    });

    test("dismissing the editor of a just-dropped marker takes the pin with it", async ({ page }) => {
        // The pin is created before the dialog so it previews live while the
        // user types - which would otherwise make Cancel and Escape mean "keep".
        await page.locator("#player-add-marker").click();
        await expect(page.locator("#marker-modal")).toBeVisible();
        await expect(page.locator(".timeline-marker")).toHaveCount(1);
        await page.locator("#marker-modal-cancel").click();
        await expect(page.locator("#marker-modal")).toBeHidden();
        await expect(page.locator(".timeline-marker"), "cancel undoes the drop").toHaveCount(0);
        await expect(page.locator("#player-marker-list")).toHaveJSProperty("hidden", true);

        // Escape is the other dismissal route and means the same thing.
        await page.locator("#player-add-marker").click();
        await expect(page.locator("#marker-modal")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator(".timeline-marker"), "escape undoes the drop").toHaveCount(0);
    });

    test("editing an existing marker keeps it when the editor is dismissed", async ({ page }) => {
        // Only a marker created by THIS open is undone by a dismissal; an
        // existing one is removed by its Delete button and nothing else.
        await addMarker(page, "keep me");
        await page.locator(".timeline-marker-hit").first().click({ button: "right" });
        await expect(page.locator("#marker-modal")).toBeVisible();
        await page.locator("#marker-modal-cancel").click();
        await expect(page.locator(".timeline-marker")).toHaveCount(1);
    });

    test("deleting the last marker empties the list and retracts the bar button", async ({ page }) => {
        await addMarker(page, "gone soon");
        await openMarkerList(page);
        await page.locator("#marker-list-items .marker-list-delete").first().click();

        await expect(page.locator("#marker-list-items .marker-list-row")).toHaveCount(0);
        await expect(page.locator("#marker-list-empty")).toBeVisible();
        await expect(page.locator(".timeline-marker")).toHaveCount(0);
        await expect(page.locator("#player-marker-list")).toHaveJSProperty("hidden", true);
    });
});

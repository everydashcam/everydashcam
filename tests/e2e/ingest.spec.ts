// Ingest: the SD-card -> sidebar -> active trip pipeline. This is the flow a
// human exercises first on every manual pass. Asserts that a real multichannel
// trip indexes, activates, and renders all panels - and that a single-channel
// camera does NOT show multichannel affordances. The tile server is aborted by
// the fixture, so these also prove the map degrades gracefully (no base layer,
// everything else works) without tripping the error sentinel.

import {
    DESKTOP,
    SAMPLE_70MAI,
    SAMPLE_GOPRO,
    expect,
    gotoApp,
    loadTrip,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";
import { checkFolderMulticam } from "./_channel-folders.js";

test.describe("ingest", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
    });

    test("folder channels form a multicamera trip per card", async ({ page }, info) => {
        await checkFolderMulticam(page, info.outputPath("cards"));
    });

    test("70mai multichannel: indexes, activates, renders every panel", { tag: "@golden-ingest" }, async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);

        // Sidebar shows at least one real trip card (not the unindexed note).
        const trips = page.locator("li.trip:not(.unindexed-note)");
        await expect(trips.first()).toBeVisible({ timeout: 30_000 });
        expect(await trips.count(), "70mai sample yields at least one trip").toBeGreaterThanOrEqual(1);

        await trips.first().click();

        // Active trip: chart canvas painted with non-zero width, scrubber spans
        // a real duration (total advanced past 0:00).
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        await expect
            .poll(async () => (await page.locator("#player-total").textContent())?.trim(), {
                timeout: 15_000,
            })
            .not.toBe("0:00");

        // Multichannel grid: front + rear + interior tiles all present & visible.
        for (const ch of ["front", "rear", "interior"] as const) {
            await expect(
                page.locator(`#video-grid .video-tile[data-channel="${ch}"]`),
                `${ch} tile must render`,
            ).toBeVisible();
        }

        // Map degradation guard: the MapLibre canvas still mounts with non-zero
        // size even though every tile request was aborted by the fixture.
        const mapCanvas = page.locator(".mini-map canvas.maplibregl-canvas").first();
        await expect(mapCanvas).toBeVisible();
        const canvasBox = await mapCanvas.boundingBox();
        expect(canvasBox, "map canvas must have a size with the tile server down").not.toBeNull();
        expect(canvasBox!.width).toBeGreaterThan(0);

        await shot(page, "ingest-01-multichannel-active");
    });

    test("gopro single-channel: no multichannel UI", { tag: "@golden-ingest" }, async ({ page }) => {
        await loadTrip(page, SAMPLE_GOPRO);

        // A single camera has no F/R/I split, so the channel switcher must stay
        // hidden and the grid must hold exactly one tile.
        await expect(page.locator("#channel-switcher")).toBeHidden();
        await expect(page.locator("#video-grid .video-tile:not([hidden])")).toHaveCount(1);

        await shot(page, "ingest-02-gopro-single");
    });

    // Both rebuild the whole list from their own handler - the star also floats
    // the card into the favorites group - so each is a chance to drop the
    // keyboard user on <body> with the card they were on now somewhere else.
    // (trip-edit is deliberately absent: it opens a dialog, which owns focus
    // until it closes.)
    for (const action of ["chevron", "trip-fav"]) {
        test(`keyboard focus survives activating the ${action} control`, async ({ page }) => {
            await loadTrip(page, SAMPLE_70MAI);
            const control = page.locator(`li.trip [data-action="${action}"]`).first();
            await expect(control).toBeVisible();

            if (action === "trip-fav") {
                // First-edit storage selection owns focus until it is settled.
                await control.click();
                const storage = page.locator("#notes-storage-modal");
                await expect(storage).toBeVisible();
                await storage.getByRole("button", { name: "Only in this browser" }).click();
                await expect(storage).toBeHidden();
            }

            await control.focus();
            await expect(control).toBeFocused();
            await page.keyboard.press("Enter");

            // The node itself is gone - the list was rebuilt - so assert on
            // where focus LANDED, not on the original handle.
            const focused = await page.evaluate(
                () => document.activeElement?.closest("[data-action]")?.getAttribute("data-action") ?? null,
            );
            expect(focused, "focus stays on the control, not <body>").toBe(action);
        });
    }
});

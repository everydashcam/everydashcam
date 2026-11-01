import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { DESKTOP, SAMPLE_NOGPS, expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

/** Trigger the same list rebuild as background recording analysis without
 * moving keyboard focus to a sort control. */
async function refreshList(page: Page): Promise<void> {
    await page.locator("#trip-sort-key").evaluate((select) => select.dispatchEvent(new Event("change")));
}

test("the calendar keeps its focused day or month button when the trip list refreshes", async ({ page }, info) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    const directory = info.outputPath("card");
    mkdirSync(directory, { recursive: true });
    const footage = readFileSync(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"));
    for (const day of ["20260914", "20260915", "20261001"]) {
        writeFileSync(path.join(directory, `NO${day}-080000-000001F.MP4`), footage);
    }
    await page.locator("#folder-input").setInputFiles(directory);
    await expect(page.locator("#trip-list li.trip")).toHaveCount(3);
    await expect(page.locator("#trip-analysis-status")).toBeHidden();

    await page.locator("#trip-jump").click();
    const calendar = page.locator("#trip-jump-panel");
    await calendar.getByRole("button", { name: "Previous month" }).click();
    const day = calendar.locator('[data-day-key="d:2026-09-15"]');
    await day.focus();
    await refreshList(page);
    await expect(day).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(calendar.locator('[data-day-key="d:2026-09-14"]')).toBeFocused();

    const nextMonth = calendar.getByRole("button", { name: "Next month" });
    await nextMonth.focus();
    await refreshList(page);
    await expect(nextMonth).toBeFocused();

    // Tabbing out leaves the nonmodal calendar open. A later background
    // refresh must not take focus back from the search field.
    const search = page.locator("#trip-search");
    await search.focus();
    await refreshList(page);
    await expect(calendar).toBeVisible();
    await expect(search).toBeFocused();
});

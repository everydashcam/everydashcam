import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { DESKTOP, SAMPLE_NOGPS, expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

const footage = readFileSync(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"));
const fixtureDirectories: string[] = [];
// Two September days with a parking night between them, and one October drive.
const filenames = [
    "Normal/Front/NO20260914-080000-000001F.MP4",
    "Lapse/Front/LA20260914-231000-000002F.MP4",
    "Lapse/Front/LA20260915-013000-000003F.MP4",
    "Lapse/Front/LA20260915-034500-000004F.MP4",
    "Normal/Front/NO20260915-083000-000005F.MP4",
    "Normal/Front/NO20261001-090000-000006F.MP4",
];

async function addRecordings(page: Page): Promise<void> {
    const directory = mkdtempSync(path.join(tmpdir(), "everydashcam-trip-groups-"));
    fixtureDirectories.push(directory);
    for (const name of filenames) {
        const filename = path.join(directory, name);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, footage);
    }
    await page.locator("#folder-input").setInputFiles(directory);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.ingestController === null)).toBe(true);
    await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 30_000 });
}

test.afterAll(() => {
    for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
});

const toggle = (section: ReturnType<Page["locator"]>) =>
    section.locator(":scope > .trip-group__header > .trip-group-toggle");

test("groups the date-sorted list by month and day and folds a parking night", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page);

    const months = page.locator(".trip-month");
    await expect(months).toHaveCount(2);
    await expect(toggle(months.nth(0))).toContainText("October 2026");
    await expect(toggle(months.nth(1))).toContainText("September 2026");
    const days = months.nth(1).locator(".trip-day");
    await expect(days).toHaveCount(2);
    await expect(toggle(days.nth(0))).toContainText("Sep 15");
    await expect(toggle(days.nth(1))).toContainText("Sep 14");

    // The night belongs to the day it began and starts folded.
    const run = days.nth(1).locator(".trip-parking-run");
    await expect(run).toHaveCount(1);
    await expect(toggle(run)).toHaveAttribute("aria-expanded", "false");
    await expect(toggle(run)).toContainText("Parked 23:10 → Tue 03:45");
    await expect(toggle(run)).toContainText("3 trips");
    const visibleCards = page.locator("#trip-list li.trip:visible");
    await expect(visibleCards).toHaveCount(3);

    await toggle(run).click();
    await expect(toggle(run)).toHaveAttribute("aria-expanded", "true");
    await expect(visibleCards).toHaveCount(6);

    await toggle(days.nth(0)).click();
    await expect(toggle(days.nth(0))).toHaveAttribute("aria-expanded", "false");
    await expect(days.nth(0).locator("li.trip")).toBeHidden();
    await expect(visibleCards).toHaveCount(5);

    // Folding survives a full re-render (a sort round trip rebuilds the list).
    await page.locator("#trip-sort-key").selectOption("duration");
    await expect(page.locator(".trip-month")).toHaveCount(0);
    await page.locator("#trip-sort-key").selectOption("date");
    await expect(toggle(page.locator(".trip-day").nth(1))).toHaveAttribute("aria-expanded", "false");
    await expect(toggle(page.locator(".trip-parking-run"))).toHaveAttribute("aria-expanded", "true");
});

test("opens the folded parking night when playback advances into it", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page);
    const run = page.locator(".trip-parking-run");
    await expect(toggle(run)).toHaveAttribute("aria-expanded", "false");

    await page.evaluate(() => {
        window.__everydashcam.state.tripEndBehavior = "advance";
    });
    // The Sep 14 morning drive; the night's first trip is chronologically next.
    await page.locator("#trip-list li.trip:visible .trip-title").filter({ hasText: "08:00" }).click();
    await expect(toggle(run)).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
    await expect(run.locator("li.trip.active")).toBeVisible();
});

test("switches to compact rows and keeps the choice after a reload", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page);
    const density = page.locator("#trip-density");
    await expect(density).toHaveAttribute("aria-pressed", "false");

    await density.click();
    await expect(density).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#trip-list")).toHaveClass(/is-rows/);
    // Under date sort the day heading names the date, so a row shows the clock only.
    const october = page.locator(".trip-month").first();
    await expect(october.locator("li.trip .trip-title")).toHaveText("09:00 → 09:00");
    await expect(october.locator("li.trip .trip-thumb")).toHaveCount(1);
    const box = await october.locator("li.trip").boundingBox();
    expect(box?.height ?? 0).toBeLessThan(60);

    await page.reload();
    await expect(page.locator("#trip-density")).toHaveAttribute("aria-pressed", "true");
});

test("searches trips by date and clears the search with the filters", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page);
    await expect(page.locator("#trip-filter-tray")).toBeHidden();

    await page.locator("#trip-search").fill("oct 1");
    await expect(page.locator(".trip-month")).toHaveCount(1);
    await expect(page.locator("#trip-filter-result")).toHaveText("Showing 1 of 6");
    // A one-digit day matches only that day, not every date with a 1 in it.
    await page.locator("#trip-search").fill("sep 1");
    await expect(page.locator(".trip-filter-empty")).toBeVisible();

    await page.locator(".trip-filter-empty .trip-filter-reset").click();
    await expect(page.locator("#trip-search")).toHaveValue("");
    await expect(page.locator(".trip-month")).toHaveCount(2);
    await expect(page.locator("#trip-search")).toBeFocused();
});

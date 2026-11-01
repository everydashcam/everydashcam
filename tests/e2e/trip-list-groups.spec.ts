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

async function addRecordings(page: Page, names: readonly string[] = filenames): Promise<void> {
    const directory = mkdtempSync(path.join(tmpdir(), "everydashcam-trip-groups-"));
    fixtureDirectories.push(directory);
    for (const name of names) {
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

test("keeps separate parking stays when the drive between them is favorited or filtered out", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page, [
        "Lapse/Front/LA20260914-090000-000001F.MP4",
        "Lapse/Front/LA20260914-093000-000002F.MP4",
        "Normal/Front/NO20260914-100000-000003F.MP4",
        "Lapse/Front/LA20260914-110000-000004F.MP4",
        "Lapse/Front/LA20260914-113000-000005F.MP4",
    ]);
    const runs = page.locator(".trip-parking-run");
    await expect(runs).toHaveCount(2);

    await page
        .locator("li.trip")
        .filter({ has: page.locator(".trip-title", { hasText: "10:00" }) })
        .locator(".trip-fav")
        .click();
    await page.locator("#notes-storage-browser").click();
    await expect(page.locator("#notes-storage-modal")).toBeHidden();
    await expect(runs).toHaveCount(2);
    await expect(toggle(runs.nth(0))).toContainText("Parked 11:00 → 11:30");
    await expect(toggle(runs.nth(1))).toContainText("Parked 09:00 → 09:30");

    await page.locator('.trip-fav[aria-pressed="true"]').click();
    await page.locator("#trip-filter-toggle").click();
    await page.locator('[data-trip-filter-kind="parking"]').click();
    await expect(page.locator("#trip-filter-result")).toHaveText("Showing 4 of 5");
    await expect(runs).toHaveCount(2);
    await expect(toggle(runs.nth(0))).toContainText("2 trips");
    await expect(toggle(runs.nth(1))).toContainText("2 trips");
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

test("keeps keyboard focus when a starred trip moves into a folded favorites section", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page, [
        "Normal/Front/NO20260914-080000-000001F.MP4",
        "Normal/Front/NO20261001-090000-000002F.MP4",
    ]);

    await page.locator("li.trip .trip-fav").first().click();
    await page.locator("#notes-storage-browser").click();
    await expect(page.locator("#notes-storage-modal")).toBeHidden();
    const favorites = page.locator(".trip-month").first();
    await toggle(favorites).click();
    await expect(toggle(favorites)).toHaveAttribute("aria-expanded", "false");

    await page.locator(".trip-day .trip-fav").focus();
    await page.keyboard.press("Space");
    await expect(favorites.locator("li.trip")).toHaveCount(2);
    await expect(favorites.locator(".trip-fav").last()).toBeFocused();
    await expect(toggle(favorites)).toHaveAttribute("aria-expanded", "true");
});

test("switches to compact rows and keeps the choice after a reload", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page);
    const rows = page.locator('#trip-density [data-density="rows"]');
    const cards = page.locator('#trip-density [data-density="cards"]');
    await expect(cards).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveAttribute("aria-pressed", "false");

    await rows.click();
    await expect(rows).toHaveAttribute("aria-pressed", "true");
    await expect(cards).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#trip-list")).toHaveClass(/is-rows/);
    // Under date sort the day heading names the date, so a row shows the clock only.
    const october = page.locator(".trip-month").first();
    await expect(october.locator("li.trip .trip-title")).toHaveText("09:00 → 09:00");
    await expect(october.locator("li.trip .trip-thumb")).toHaveCount(1);
    const box = await october.locator("li.trip").boundingBox();
    expect(box?.height ?? 0).toBeLessThan(60);

    // The run belongs to Sep 14, but its after-midnight rows must retain Sep 15.
    const run = page.locator(".trip-parking-run");
    await toggle(run).click();
    await expect(run.locator(".trip-title")).toHaveText([/Sep 15.*03:45/, /Sep 15.*01:30/, "23:10 → 23:10"]);

    await page.reload();
    await expect(page.locator('#trip-density [data-density="rows"]')).toHaveAttribute("aria-pressed", "true");
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

test("jumps to a day from the calendar", async ({ page }) => {
    await presetLocalStorage(page);
    // Short enough that the six-trip list has to scroll to reach September.
    await page.setViewportSize({ width: DESKTOP.width, height: 600 });
    await gotoApp(page);
    await addRecordings(page);
    const jump = page.locator("#trip-jump");
    const panel = page.locator("#trip-jump-panel");

    await jump.click();
    await expect(panel).toBeVisible();
    // Opens on the month at the top of the list, focused on its first day with trips.
    await expect(panel.locator(".trip-jump__title")).toHaveText("October 2026");
    await expect(panel.locator(".trip-jump__day:enabled")).toHaveCount(1);
    await expect(panel.locator(".trip-jump__day:enabled")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(jump).toBeFocused();

    await jump.click();
    await panel.getByRole("button", { name: "Previous month" }).click();
    await expect(panel.locator(".trip-jump__title")).toHaveText("September 2026");
    const days = panel.locator(".trip-jump__day:enabled");
    await expect(days).toHaveText(["14", "15"]);
    await days.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(days.last()).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(days.first()).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(panel).toBeHidden();
    const day = page.locator(".trip-day").filter({ hasText: "Sep 14" });
    const dayToggle = day.locator(":scope > .trip-group__header > .trip-group-toggle");
    await expect(dayToggle).toBeFocused();
    // The day lands just under the stuck month heading, unless the list ends
    // before it can reach the top (this short fixture scrolls to its end).
    await expect(dayToggle).toBeInViewport();
    const placement = await dayToggle.evaluate((toggle) => {
        const sidebar = document.querySelector("#sidebar")!;
        return {
            offset: toggle.getBoundingClientRect().top - sidebar.getBoundingClientRect().top,
            atEnd: Math.abs(sidebar.scrollHeight - sidebar.clientHeight - sidebar.scrollTop) < 2,
            scrolled: sidebar.scrollTop > 0,
        };
    });
    expect(placement.scrolled).toBe(true);
    expect(placement.offset < 60 || placement.atEnd).toBe(true);

    await page.locator("#trip-sort-key").selectOption("duration");
    await expect(jump).toBeHidden();
});

test("writes ISO dates across the list once chosen in settings", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page);

    await page.locator("#settings-btn").click();
    const select = page.locator("#settings-date-format-select");
    // Each choice previews one sample date in its own style.
    await expect(select.locator('option[value="iso"]')).toHaveText("ISO 8601 (2026-12-31)");
    await expect(select.locator('option[value="locale"]')).toHaveText("Language default (Dec 31, 2026)");
    await select.selectOption("iso");
    await page.locator("#settings-modal-close").click();

    const months = page.locator(".trip-month");
    await expect(toggle(months.nth(0))).toContainText("2026-10");
    await expect(toggle(months.nth(1).locator(".trip-day").nth(0))).toContainText("2026-09-15 Tue");
    await expect(months.nth(0).locator("li.trip .trip-title")).toHaveText("2026-10-01 09:00 → 09:00");

    await page.reload();
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-date-format-select")).toHaveValue("iso");
});

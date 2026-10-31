import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { DESKTOP, MOBILE, SAMPLE_NOGPS, boxOf, expect, gotoApp, presetLocalStorage, shot, test } from "./_fixtures.js";

const footage = readFileSync(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"));
const fixtureDirectories: string[] = [];
const filenames = [
    "Normal/Front/NO20260915-080000-000001F.MP4",
    "Event/Front/EV20260915-080010-000002F.MP4",
    "Event/Back/EV20260915-080010-000002B.MP4",
    "Lapse/Front/LA20260915-090000-000003F.MP4",
    "Event/Front/PA20260915-090010-000004F.MP4",
    "Normal/Front/NO20260915-100000-000005F.MP4",
    "Manual/Front/NO20260915-100010-000006F.MP4",
    "Lapse/Front/LA20260915-110000-000007F.MP4",
    "clip-no-gps.mp4",
];

async function addRecordings(page: Page, names: string[]): Promise<void> {
    const directory = mkdtempSync(path.join(tmpdir(), "everydashcam-trip-filters-"));
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

const kind = (page: Page, value: string) => page.locator(`[data-trip-filter-kind="${value}"]`);
const recording = (page: Page, value: string) => page.locator(`[data-trip-filter-toggle="${value}"]`);
const cards = (page: Page) => page.locator("#trip-list li.trip[data-trip-index]");

/** The filter chips live in a tray behind the toggle next to the search field. */
async function openFilters(page: Page): Promise<void> {
    const toggle = page.locator("#trip-filter-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(page.locator("#trip-filter-tray")).toBeVisible();
}

test("filters whole trips by recording type without changing playback", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page, filenames);
    await openFilters(page);
    await expect(cards(page)).toHaveCount(5);
    await expect(kind(page, "normal")).toHaveText("Normal2");
    await expect(kind(page, "parking")).toHaveText("Parking2");
    await expect(kind(page, "unknown")).toHaveCount(0);
    await expect(recording(page, "event")).toHaveText("With events2");
    await expect(recording(page, "manual")).toHaveText("Manually saved1");
    await expect(recording(page, "notes")).toBeHidden();
    await expect(recording(page, "favorites")).toBeHidden();

    await kind(page, "normal").click();
    await recording(page, "manual").click();
    await expect(cards(page)).toHaveCount(1);
    await cards(page).locator(".trip-title").click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.active !== null)).toBe(true);
    await expect(page.locator("#player-total")).not.toHaveText("0:00");
    const playback = await page.evaluate(() => ({
        trip: window.__everydashcam.state.active!.trip,
        source: window.__everydashcam.dom.player.src,
    }));

    await expect(kind(page, "parking")).toBeHidden();
    await recording(page, "manual").click();
    await kind(page, "parking").click();
    await expect(cards(page)).toHaveCount(2);
    await expect(recording(page, "manual")).toBeHidden();
    await expect(page.locator("body")).not.toHaveClass(/browsing/);
    expect(
        await page.evaluate(() => ({
            trip: window.__everydashcam.state.active!.trip,
            source: window.__everydashcam.dom.player.src,
        })),
    ).toEqual(playback);

    await recording(page, "event").click();
    await expect(cards(page)).toHaveCount(1);
    await cards(page).locator('[data-action="chevron"]').click();
    await expect(cards(page).locator("li[data-frame-index]")).toHaveCount(2);
    await expect(page.locator("#trip-filter-result")).toHaveText("Showing 1 of 5");

    await kind(page, "all").click();
    await expect(cards(page)).toHaveCount(2);
    await recording(page, "manual").click();
    await expect(cards(page)).toHaveCount(3);
    await page.locator("#trip-filter-reset").click();
    await expect(cards(page)).toHaveCount(5);
    await expect(kind(page, "all")).toBeFocused();
});

test("keeps available filters in two compact rows", async ({ page }) => {
    await presetLocalStorage(page, { theme: "light" });
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(
        page,
        filenames.filter((name) => !name.startsWith("Manual/")),
    );
    await openFilters(page);
    await cards(page).first().locator(".trip-fav").click();
    await page.locator("#notes-storage-modal").getByRole("button", { name: "Only in this browser" }).click();
    await expect(page.locator("#notes-storage-modal")).toBeHidden();
    await page.locator("#sidebar-resize").focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    const all = await boxOf(page, '[data-trip-filter-kind="all"]');
    for (const value of ["normal", "parking"]) {
        expect((await boxOf(page, `[data-trip-filter-kind="${value}"]`)).y).toBe(all.y);
    }
    const events = await boxOf(page, '[data-trip-filter-toggle="event"]');
    const favorites = await boxOf(page, '[data-trip-filter-toggle="favorites"]');
    expect(favorites.y).toBe(events.y);
    expect((await boxOf(page, "#trip-filter-tray")).height).toBeLessThan(70);
    await expect(kind(page, "unknown")).toHaveCount(0);
    await expect(recording(page, "manual")).toBeHidden();
    await expect(recording(page, "notes")).toBeHidden();
    await shot(page, "trip-filters-compact");
});

test("keeps filters and keyboard focus while more recordings arrive", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page, filenames);
    await openFilters(page);
    await recording(page, "event").focus();
    await page.keyboard.press("Space");
    await expect(cards(page)).toHaveCount(2);
    await addRecordings(page, [
        "Lapse/Front/LA20260915-120000-000008F.MP4",
        "Event/Front/PA20260915-120010-000009F.MP4",
    ]);
    await expect(recording(page, "event")).toHaveAttribute("aria-pressed", "true");
    await expect(recording(page, "event")).toBeFocused();
    await expect(cards(page)).toHaveCount(3);
    await expect(kind(page, "parking")).toHaveText("Parking2");
    await expect(page.locator("#trip-filter-result")).toHaveText("Showing 3 of 6");
    await page.locator("#trip-sort-key").selectOption("duration");
    await expect(cards(page)).toHaveCount(3);
    await expect(recording(page, "event")).toHaveAttribute("aria-pressed", "true");
});

test("combines note and favorite filters and updates them after edits", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await addRecordings(page, filenames);
    await openFilters(page);
    await kind(page, "normal").click();
    await expect(cards(page)).toHaveCount(2);
    const notedIndex = await cards(page).nth(0).getAttribute("data-trip-index");
    const namedIndex = await cards(page).nth(1).getAttribute("data-trip-index");
    const noted = page.locator(`li.trip[data-trip-index="${notedIndex}"]`);
    const named = page.locator(`li.trip[data-trip-index="${namedIndex}"]`);
    await noted.locator(".trip-edit").click();
    await page.locator("#trip-meta-note").fill("Roadworks by the bridge");
    await page.locator("#trip-meta-save").click();
    await page.locator("#notes-storage-modal").getByRole("button", { name: "Only in this browser" }).click();
    await expect(page.locator("#notes-storage-modal")).toBeHidden();
    await noted.locator(".trip-fav").click();
    await named.locator(".trip-edit").click();
    await page.locator("#trip-meta-name").fill("Morning drive");
    await page.locator("#trip-meta-save").click();
    await named.locator(".trip-fav").click();
    const notes = page.locator('[data-trip-filter-toggle="notes"]');
    const favorites = page.locator('[data-trip-filter-toggle="favorites"]');
    await expect(notes).toHaveText("With notes1");
    await expect(favorites).toHaveText("Favorites2");
    await favorites.click();
    await expect(cards(page)).toHaveCount(2);
    await notes.click();
    await expect(cards(page)).toHaveCount(1);
    await expect(noted).toBeVisible();
    await expect(favorites).toHaveText("Favorites1");
    await expect(recording(page, "event")).toBeHidden();
    await noted.locator(".trip-edit").click();
    await page.locator("#trip-meta-note").fill("");
    await page.locator("#trip-meta-save").click();
    await expect(cards(page)).toHaveCount(0);
    await expect(notes).toHaveText("With notes0");
    await expect(notes).toBeVisible();
    await expect(page.locator(".trip-filter-empty")).toContainText("No trips match these filters.");
    await expect(page.locator("#trip-filter-reset")).toBeFocused();
    await notes.click();
    await expect(cards(page)).toHaveCount(2);
    await expect(notes).toBeHidden();
    await expect(kind(page, "all")).toBeFocused();
    await named.locator(".trip-fav").click();
    await expect(cards(page)).toHaveCount(1);
    await expect(page.locator("#trip-filter-reset")).toBeFocused();
    await expect(favorites).toHaveText("Favorites1");
    await page.locator("#trip-filter-reset").click();
    await expect(cards(page)).toHaveCount(5);
    await expect(notes).toHaveAttribute("aria-pressed", "false");
    await expect(favorites).toHaveAttribute("aria-pressed", "false");
});

test.describe("touch filters", () => {
    test.use({ hasTouch: true });
    test("Russian filters fit a narrow sidebar and a touch screen", async ({ page }) => {
        await presetLocalStorage(page, { theme: "light" });
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "ru");
        await addRecordings(
            page,
            filenames.filter((name) => name !== "clip-no-gps.mp4"),
        );
        await openFilters(page);
        await expect(kind(page, "unknown")).toHaveCount(0);
        await expect(kind(page, "normal")).toHaveText("Обычные2");
        await page.locator("#sidebar-resize").focus();
        await page.keyboard.press("Home");
        expect(await page.locator("#sidebar").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await shot(page, "trip-filters-narrow");
        await page.setViewportSize(MOBILE);
        await kind(page, "parking").click();
        await expect(recording(page, "manual")).toBeHidden();
        await recording(page, "event").click();
        await expect(cards(page)).toHaveCount(1);
        await page.locator("#trip-filter-reset").click();
        await expect(cards(page)).toHaveCount(4);
        await expect(kind(page, "all")).toBeFocused();
        expect(await page.locator("#sidebar").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await shot(page, "trip-filters-mobile");
    });
});

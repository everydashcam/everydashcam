import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, pausePlayback } from "./_fixtures.js";

export async function checkNovatekTsSpeed(page: Page): Promise<void> {
    await page.locator("#file-input").setInputFiles({
        name: "20261017234443_000283.TS",
        mimeType: "video/mp2t",
        buffer: readFileSync(resolve("src/parsers/__fixtures__/novatek-ts/real-kmh-anonymized.TS")),
    });
    const trip = page.locator("li.trip:not(.unindexed-note)");
    await expect(trip).toHaveCount(1);
    await trip.click();
    await expect(page.locator("#trip-analysis-status")).toBeHidden();
    await expect(page.locator(".player-no-gps")).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.trips[0]!.records.length)).toBe(30);
    const speeds = await page.evaluate(() =>
        window.__everydashcam.state.trips[0]!.records.map((record) => record.speedMs * 3.6),
    );
    expect(speeds[0]).toBeCloseTo(37.37336, 4);
    expect(speeds[28]).toBeCloseTo(20.87204, 4);
    await pausePlayback(page);
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Home");
    await expect(page.locator("#pm-speed")).toHaveText("37.4");
}

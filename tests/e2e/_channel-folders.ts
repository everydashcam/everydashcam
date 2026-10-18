import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REPO_ROOT } from "./_fixtures.js";

/** Exercise path-based pairing with playable TS bytes and synthetic card paths. */
export async function checkFolderMulticam(page: Page, directory: string): Promise<void> {
    const fixture = join(REPO_ROOT, "src/parsers/__fixtures__/ligogps-trailer-ts/real-anonymized-empty.TS");
    for (const [index, root] of ["card-a", "card-b"].entries()) {
        for (const [folder, stamp, counter] of [
            ["Front", "20260101120014", 1],
            ["Rear", "20260101120015", 2],
        ] as const) {
            // Distinct counters keep the two fixture copies out of ingest's
            // duplicate-file filter while preserving the same camera-key mask.
            const name = `${stamp}_${String(index * 2 + counter).padStart(6, "0")}.TS`;
            const target = join(directory, root, "MOVIE", folder);
            mkdirSync(target, { recursive: true });
            copyFileSync(fixture, join(target, name));
        }
    }
    await page.locator("#folder-input").setInputFiles(directory);
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(2);
    await trips.first().click();
    await expect(page.locator("#trip-analysis-status")).toBeHidden();
    await expect(trips).toHaveCount(2);
    for (const channel of ["front", "rear"]) {
        await expect(page.locator(`#video-grid .video-tile[data-channel="${channel}"]`)).toBeVisible();
    }
    await expect
        .poll(() =>
            page
                .locator("#video-grid .video-tile:not([hidden]) > video:not(.preload-slot):not(.tile-blur-bg)")
                .evaluateAll(
                    (videos: HTMLVideoElement[]) =>
                        videos.length === 2 && videos.every((video) => video.readyState >= 2),
                ),
        )
        .toBe(true);
}

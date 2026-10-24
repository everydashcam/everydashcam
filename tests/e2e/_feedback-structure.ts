import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { write70maiHiddenGpsCard } from "./_70mai-card.js";
import { expect, SAMPLE_70MAI } from "./_fixtures.js";

const EXCLUDED_FILES = [
    [".s_Front/proxy.MP4", "hidden path"],
    [".vendor-data/nested/route.dat", "hidden path"],
    ["System Volume Information/index.dat", "system path"],
    ["DCIM/200video/front/small/20260817190140_0060_S.mp4", "preview recording"],
] as const;
const CONTENT_SENTINEL = "file contents must not appear in the structure report";

/** A synthetic card combines hidden telemetry with rejected camera/system paths. */
export function writeFeedbackStructureCard(directory: string): void {
    write70maiHiddenGpsCard(directory);
    const video = join(SAMPLE_70MAI, "Normal", "Front", "NO20260101-120000-000001F.MP4");
    for (const [relativePath] of EXCLUDED_FILES) {
        const destination = join(directory, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        if (/\.mp4$/i.test(relativePath)) copyFileSync(video, destination);
        else writeFileSync(destination, CONTENT_SENTINEL);
    }
}

function expectEntry(report: string, relativePath: string, marker: string): void {
    const escapedPath = relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = report.split("\n").find((candidate) => new RegExp(`${escapedPath}\\s`).test(candidate));
    expect(line, `the report lists ${relativePath}`).toBeDefined();
    expect(line).toContain(marker);
}

/** Checks the saved report through the real feedback UI after either folder source. */
export async function checkFeedbackStructureReport(page: Page, hasEmptyDirectory = false): Promise<string> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { state } = window.__everydashcam;
                const videos = new Set(
                    state.trips.flatMap((trip) => trip.frames.flatMap((frame) => Object.values(frame.channels))),
                );
                return {
                    finished: state.ingestController === null,
                    videos: videos.size,
                    excludedVideos: [...videos].filter((video) =>
                        /(?:^|\/)(?:\.s_Front|\.vendor-data|small)\//.test(video.relativePath),
                    ).length,
                    frontGps: [...videos]
                        .filter((video) => video.channel === "front")
                        .map((video) => video.records.length)
                        .sort(),
                };
            }),
        )
        .toEqual({ finished: true, videos: 6, excludedVideos: 0, frontGps: [3, 3] });

    const report = await downloadFeedbackStructureReport(page);
    expect(report).toContain("everydashcam camera report");
    for (const section of ["excluded directories", "excluded files", "kept directories", "kept files"]) {
        expect(report).toMatch(new RegExp(`== ${section} \\(\\d+\\) ==`));
    }
    expectEntry(report, ".GPS/", "[directory; kept]");
    expectEntry(report, ".GPS/GPSData000001.txt", "[kept]");
    expectEntry(report, ".s_Front/", "excluded: hidden path");
    expectEntry(report, ".vendor-data/nested/", "excluded: hidden path");
    for (const [relativePath, reason] of EXCLUDED_FILES) expectEntry(report, relativePath, `excluded: ${reason}`);
    if (hasEmptyDirectory) expectEntry(report, ".empty-vendor/", "excluded: hidden path");
    expect(report).not.toContain(CONTENT_SENTINEL);
    return report;
}

/** The report must remain available even if the selection contains no usable files. */
export async function downloadFeedbackStructureReport(page: Page): Promise<string> {
    await page.locator("#feedback-btn").click();
    await expect(page.locator("#feedback-noingest")).toBeHidden();
    await page.locator("#feedback-recordings-skip").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#feedback-primary").click();
    return readFileSync(await (await downloadPromise).path(), "utf8");
}

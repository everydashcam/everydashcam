import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { CollectedPair } from "../../src/parsers/__fixtures__/supported-gps/grouping-cases.js";
import { expect, pausePlayback, REPO_ROOT, waitForMetadata } from "./_fixtures.js";

function writePair(directory: string, pair: CollectedPair): string[] {
    mkdirSync(directory, { recursive: true });
    return pair.files.map(({ fixture, name }) => {
        const file = join(directory, name);
        copyFileSync(join(REPO_ROOT, "src/parsers/__fixtures__/supported-gps", `${fixture}.mp4`), file);
        return file;
    });
}

function groupingState(page: Page) {
    return page.evaluate(() => {
        const state = window.__everydashcam.state;
        return state.trips.map((trip) => ({
            start: trip.startUtc,
            frames: trip.frames.map((frame) => Object.keys(frame.channels).sort()),
            files: [...new Set(trip.frames.flatMap((frame) => Object.values(frame.channels)))].map((candidate) => ({
                name: candidate.file.name,
                path: candidate.relativePath,
                source: candidate.sourceKey,
                fingerprint: candidate.fingerprint,
                channel: candidate.channel,
                ready: candidate.metadataReady,
                start: candidate.startUtc,
                startSource: candidate.startSource,
                createdUtc: candidate.createdUtc?.toISOString() ?? null,
                duration: candidate.durationSec,
                gpsCount: candidate.records.length,
                gpsFirst: candidate.records[0]?.unixSeconds ?? null,
                gpsLast: candidate.records.at(-1)?.unixSeconds ?? null,
                extractors: candidate.appliedExtractors,
            })),
        }));
    });
}

/** Exercise real container indexing and GPS refinement after filename grouping. */
export async function checkCollectedChannelPair(
    page: Page,
    info: TestInfo,
    pair: CollectedPair,
    selection: "folder" | "files",
): Promise<void> {
    const directory = info.outputPath("card");
    const files = writePair(directory, pair);
    await page
        .locator(selection === "folder" ? "#folder-input" : "#file-input")
        .setInputFiles(selection === "folder" ? directory : files);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const state = window.__everydashcam.state;
                    return (
                        state.trips.length > 0 &&
                        state.ingestController === null &&
                        state.recordingAnalysisProgress === null &&
                        state.readingTrips.size === 0
                    );
                }),
            { timeout: 30_000 },
        )
        .toBe(true);
    await waitForMetadata(page);
    const grouped = await groupingState(page);
    await info.attach("grouping-after-ingest.json", {
        body: JSON.stringify(grouped, null, 2),
        contentType: "application/json",
    });
    expect(
        grouped.map((trip) => trip.files.map((file) => file.name).sort()),
        "metadata and GPS refinement preserve the recording groups",
    ).toEqual(pair.groups.map((group) => [...group].sort()));
    const candidates = grouped.flatMap((trip) => trip.files);
    expect(new Set(candidates.map((file) => file.source)).size).toBe(1);
    for (const trip of grouped) {
        expect(new Set(trip.files.map((file) => file.fingerprint)).size).toBe(1);
        expect(trip.frames).toEqual([trip.files.map((file) => file.channel).sort()]);
    }
    for (const fixture of pair.files) {
        const candidate = candidates.find((file) => file.name === fixture.name);
        expect(candidate).toMatchObject({
            ready: true,
            channel: fixture.channel,
            gpsCount: fixture.gpsCount,
            duration: 60,
            start: fixture.start,
            startSource: "mp4",
            createdUtc: fixture.createdUtc,
            extractors: fixture.gpsCount > 0 ? ["freegps"] : [],
        });
    }

    for (const trip of grouped) {
        await page
            .locator("li.trip")
            .filter({ has: page.locator(".file-name", { hasText: trip.files[0]!.name }) })
            .locator(".trip-title")
            .click();
        await pausePlayback(page);
        await expect(page.locator("#trip-analysis-status")).toBeHidden();
        if (trip.files.some((file) => file.gpsCount > 0)) await expect(page.locator(".player-no-gps")).toBeHidden();
        else await expect(page.locator(".player-no-gps")).toBeVisible();
    }
    const opened = await groupingState(page);
    await info.attach("grouping-after-open.json", {
        body: JSON.stringify(opened, null, 2),
        contentType: "application/json",
    });
    expect(opened, "opening the trip preserves all independently decoded channels").toEqual(grouped);
}

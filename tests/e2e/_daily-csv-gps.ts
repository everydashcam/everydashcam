import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { GeoJSONSource } from "maplibre-gl";
import { expect, openTripWithRecording, pausePlayback, REPO_ROOT, SAMPLE_NOGPS } from "./_fixtures.js";

const RECORDINGS = [
    { name: "20240112181419_180.MP4", folder: "100video", mode: "normal", knots: [50.965, 50.862, 50.977] },
    { name: "20240113175916_10.MP4", folder: "101video", mode: "event", knots: [49.721, 48.869, 47.802] },
] as const;

function writeDailyCsvCard(
    directory: string,
    videos: readonly (typeof RECORDINGS)[number][] = RECORDINGS,
    includeLogs = true,
): void {
    const gpsDirectory = join(directory, "gps");
    if (includeLogs) mkdirSync(gpsDirectory, { recursive: true });
    for (const [index, recording] of RECORDINGS.entries()) {
        if (videos.includes(recording)) {
            const videoDirectory = join(directory, "DCIM", recording.folder);
            mkdirSync(videoDirectory, { recursive: true });
            const bytes = readFileSync(join(SAMPLE_NOGPS, "clip-no-gps.mp4"));
            const mvhd = bytes.indexOf("mvhd", 0, "ascii");
            if (mvhd < 0 || bytes[mvhd + 4] !== 0) throw new Error("fixture needs a version-0 mvhd box");
            // Keep the generic no-GPS footage distinct through copy deduplication.
            bytes.writeUInt32BE(index + 1, mvhd + 12);
            writeFileSync(join(videoDirectory, recording.name), bytes);
        }
        if (!includeLogs) continue;

        const logName = `${recording.name.slice(0, 8)}.dat`;
        const lines = readFileSync(join(REPO_ROOT, "src/parsers/__fixtures__/daily-csv-gps", logName), "utf8").split(
            /\r?\n/,
        );
        const first = lines.findIndex((line) => line.startsWith(`${recording.name.slice(0, 14)},`));
        if (first < 0) throw new Error("daily GPS fixture lacks the recording start");
        // Use unchanged real rows within the synthetic video's three seconds;
        // later rows would be clamped to its shorter container duration.
        writeFileSync(join(gpsDirectory, logName), `#\n${lines.slice(first, first + 3).join("\n")}\n`);
    }
}

/** Daily sidecars bind to both card modes through the real worker and viewer. */
export async function checkDailyCsvGps(page: Page, directory: string): Promise<void> {
    writeDailyCsvCard(directory);
    await page.locator("#folder-input").setInputFiles(directory);
    await expectDailyRecordings(page, RECORDINGS);

    for (const recording of RECORDINGS) {
        await openTripWithRecording(page, recording.name);
        await pausePlayback(page);
        await expect(page.locator("#trip-analysis-status")).toBeHidden();
        await expect(page.locator(".player-no-gps")).toBeHidden();
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        if (recording.mode === "event") {
            // The card just opened is the active one.
            const tripCard = page.locator('li.trip[aria-current="true"]');
            await tripCard.locator('[data-action="chevron"]').click();
            await expect(tripCard.locator(".vendor-chip", { hasText: "Event" })).toBeVisible();
        }

        const telemetry = await page.evaluate(() => {
            const state = window.__everydashcam.state;
            const trip = state.trips[state.active!.trip]!;
            return {
                offsets: trip.records.map((record) => record.unixSeconds - trip.startUtc),
                coordinates: trip.records.map((record) => [record.lon, record.lat]),
                speeds: trip.records.map((record) => record.speedMs),
                chart: state.chart!.data.datasets[0]!.data,
            };
        });
        expect(telemetry.offsets, "the local sidecar clock anchors to the video's start").toEqual([0, 1, 2]);
        expect(telemetry.coordinates).toEqual(Array.from({ length: 3 }, () => [145, -36]));
        expect(telemetry.speeds).toEqual(recording.knots.map((knots) => expect.closeTo(knots * 0.514444, 6)));
        expect(telemetry.chart).toEqual(
            recording.knots.map((knots, x) => ({ x, y: expect.closeTo(knots * 0.514444 * 3.6, 6) })),
        );

        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const { map, miniMap } = window.__everydashcam.state;
                    return Promise.all(
                        [map, miniMap].map(async (view) => {
                            const source = view?.getSource("trip-line") as GeoJSONSource | undefined;
                            if (!source) return null;
                            const data = await source.getData();
                            if (data.type !== "Feature" || data.geometry.type !== "LineString") return null;
                            return data.geometry.coordinates;
                        }),
                    );
                }),
            )
            // Whole-degree anonymization makes the three fixes identical;
            // the renderer collapses duplicate positions in its line geometry.
            .toEqual([[[145, -36]], [[145, -36]]]);
    }
}

async function expectDailyRecordings(page: Page, recordings: readonly (typeof RECORDINGS)[number][]): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const candidates = new Set(
                        window.__everydashcam.state.trips.flatMap((trip) =>
                            trip.frames.flatMap((frame) => Object.values(frame.channels)),
                        ),
                    );
                    return [...candidates]
                        .map((candidate) => ({
                            name: candidate.file.name,
                            ready: candidate.metadataReady === true,
                            mode: candidate.recordingMode,
                            duration: candidate.durationSec,
                            offsets: candidate.records.map((record) => record.unixSeconds - candidate.startUtc),
                            extractors: candidate.appliedExtractors,
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                }),
            { message: "each daily sidecar binds only to its normal or event recording", timeout: 30_000 },
        )
        .toEqual(
            recordings.map(({ name, mode }) => ({
                name,
                ready: true,
                mode,
                duration: 3,
                offsets: [0, 1, 2],
                extractors: ["daily-csv-gps"],
            })),
        );
}

/** Partial picker imports retain GPS ownership and all previously loaded clips. */
export async function checkPartialDailyCsvGps(
    page: Page,
    directory: string,
    selection: "leaf-folders" | "card-fragments",
): Promise<void> {
    const first = selection === "leaf-folders" ? directory : join(directory, "first", "card");
    writeDailyCsvCard(first, [RECORDINGS[0]], false);
    await page
        .locator("#folder-input")
        .setInputFiles(selection === "leaf-folders" ? join(first, "DCIM", "100video") : first);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return (
                    state.trips.length > 0 &&
                    state.ingestController === null &&
                    state.readingTrips.size === 0 &&
                    state.recordingAnalysisProgress === null
                );
            }),
        )
        .toBe(true);

    const second = selection === "leaf-folders" ? directory : join(directory, "second", "card");
    writeDailyCsvCard(second, selection === "leaf-folders" ? [] : [RECORDINGS[1]]);
    await page.locator("#folder-input").setInputFiles(selection === "leaf-folders" ? join(second, "gps") : second);
    await expectDailyRecordings(page, selection === "leaf-folders" ? [RECORDINGS[0]] : RECORDINGS);
}

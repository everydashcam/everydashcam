import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Channel } from "../../src/parsers/types.js";
import { write70maiDatedGpsCard, write70maiHiddenGpsCard } from "./_70mai-card.js";
import {
    DESKTOP,
    expect,
    MOBILE,
    openTripWithRecording,
    pausePlayback,
    REPO_ROOT,
    SAMPLE_GOPRO,
    SAMPLE_NOGPS,
} from "./_fixtures.js";

const RECORDING_NAME = "NO20261020-162549-000239F.MP4";
const FOLLOWING_RECORDING_NAME = "NO20261020-162552-000241F.MP4";
const OTHER_RECORDING_NAME = "NO20261020-162549-000240F.MP4";
const START_UTC = Date.UTC(2026, 9, 20, 13, 25, 49) / 1000;

function writeSessionFolder(directory: string, withGps: boolean, withFollowing = false): void {
    const recordings = [
        { card: "A500S", name: RECORDING_NAME, offset: 0 },
        { card: "other-card", name: OTHER_RECORDING_NAME, offset: 0 },
        ...(withFollowing ? [{ card: "A500S", name: FOLLOWING_RECORDING_NAME, offset: 3 }] : []),
    ];
    for (const [index, { card, name, offset }] of recordings.entries()) {
        const videoDirectory = join(directory, card, "Normal", "Front");
        mkdirSync(videoDirectory, { recursive: true });
        const bytes = readFileSync(join(SAMPLE_NOGPS, "clip-no-gps.mp4"));
        const mvhd = bytes.indexOf("mvhd", 0, "ascii");
        if (mvhd < 0 || bytes[mvhd + 4] !== 0) throw new Error("fixture needs a version-0 mvhd box");
        // The synthetic clip lasts three seconds. A500S writes the local end
        // time to mvhd, while its filename contains the local recording start.
        const creationTime = Date.UTC(2026, 9, 20, 16, 25, 52) / 1000 + 2_082_844_800 + offset;
        bytes.writeUInt32BE(creationTime, mvhd + 8);
        // Distinct bytes preserve the sibling card through copy deduplication.
        bytes.writeUInt32BE(creationTime + index, mvhd + 12);
        writeFileSync(join(videoDirectory, name), bytes);
    }
    if (withGps) {
        copyFileSync(
            join(REPO_ROOT, "src/parsers/__fixtures__/70mai/real-anonymized-a500s.txt"),
            join(directory, "A500S", "GPSData.txt"),
        );
    }
}

function sessionRecordingState(page: Page) {
    return page.evaluate(() => {
        const candidates = new Set(
            window.__everydashcam.state.trips.flatMap((trip) =>
                trip.frames.flatMap((frame) => Object.values(frame.channels)),
            ),
        );
        return [...candidates]
            .map((candidate) => ({
                name: candidate.file.name,
                ready: candidate.metadataReady === true,
                start: candidate.startUtc,
                seconds: candidate.records.map((record) => record.unixSeconds),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });
}

async function openRecordingTrip(page: Page, name: string): Promise<void> {
    await openTripWithRecording(page, name);
    await pausePlayback(page);
    await expect(page.locator("#trip-analysis-status")).toBeHidden();
}

function recordingGps(page: Page, channel: Channel) {
    return page.evaluate((wanted) => {
        const recordings = new Set(
            window.__everydashcam.state.trips.flatMap((trip) =>
                trip.frames.flatMap((frame) => Object.values(frame.channels)),
            ),
        );
        return [...recordings]
            .filter((recording) => recording.channel === wanted)
            .map((recording) => ({
                name: recording.file.name,
                points: recording.records.length,
                extractors: recording.appliedExtractors,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, channel);
}

/** Trip tracks that repeat one fix (time and position) more than once. */
function duplicatedTripFixes(page: Page) {
    return page.evaluate(() =>
        window.__everydashcam.state.trips.flatMap((trip) => {
            const keys = trip.records.map((record) => `${record.unixSeconds}|${record.lat}|${record.lon}`);
            return keys.filter((key, index) => keys.indexOf(key) !== index);
        }),
    );
}

function datedFrontGps(normalPoints = 3) {
    return [
        { name: "EV20260101-120002-000002F.MP4", points: 3, extractors: ["csv-70mai-dated"] },
        { name: "NO20260101-120000-000001F.MP4", points: normalPoints, extractors: ["csv-70mai-dated"] },
    ];
}

/** A synthetic hidden telemetry layout survives the folder ingest filter. */
export async function check70maiHiddenGps(page: Page, directory: string): Promise<void> {
    write70maiHiddenGpsCard(directory);
    await page.locator("#folder-input").setInputFiles(directory);
    await expect
        .poll(() => recordingGps(page, "front"))
        .toEqual([
            { name: "NO20260101-120000-000001F.MP4", points: 3, extractors: ["csv-70mai"] },
            { name: "NO20260101-120002-000002F.MP4", points: 3, extractors: ["csv-70mai"] },
        ]);
}

/** Prefix-less clip names in a dated `.GPS` log reach normal and event clips. */
export async function check70maiDatedGps(page: Page, directory: string, hasMalformedFirstRow = false): Promise<void> {
    write70maiDatedGpsCard(directory);
    if (hasMalformedFirstRow) {
        const logPath = join(directory, ".GPS", "GPSData000001.txt");
        writeFileSync(logPath, readFileSync(logPath, "utf8").replace("050km/h", "broken"));
    }
    await page.locator("#folder-input").setInputFiles(directory);
    await expect.poll(() => recordingGps(page, "front")).toEqual(datedFrontGps(hasMalformedFirstRow ? 2 : 3));
    // Only the first recording's rear clip is named in the log.
    expect(await recordingGps(page, "rear")).toEqual([
        { name: "NO20260101-120000-000001B.MP4", points: 3, extractors: ["csv-70mai-dated"] },
        { name: "NO20260101-120002-000002B.MP4", points: 0, extractors: [] },
    ]);
    expect(await duplicatedTripFixes(page), "front and rear copies of one fix collapse in the trip").toEqual([]);
}

/** Stored prefix-less rows bind when the matching video arrives in a later drop. */
export async function check70maiDatedGpsIncremental(
    page: Page,
    directory: string,
    hasInitialVideo: boolean,
): Promise<void> {
    write70maiDatedGpsCard(directory);
    const logPath = join(directory, ".GPS", "GPSData000001.txt");
    const normalPath = join(directory, "Normal", "Front", "NO20260101-120000-000001F.MP4");
    const eventPath = join(directory, "Event", "Front", "EV20260101-120002-000002F.MP4");
    const input = page.locator("#file-input");
    await input.setInputFiles(hasInitialVideo ? [logPath, normalPath] : [logPath]);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.gpsLog?.records.length)).toBe(9);
    await expect.poll(() => recordingGps(page, "front")).toEqual(hasInitialVideo ? [datedFrontGps()[1]] : []);

    await input.setInputFiles(hasInitialVideo ? [eventPath] : [normalPath, eventPath]);
    await expect.poll(() => recordingGps(page, "front")).toEqual(datedFrontGps());

    await input.setInputFiles(logPath);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return (
                    state.ingestController === null && state.ingestQueue.length === 0 && state.readingTrips.size === 0
                );
            }),
        )
        .toBe(true);
    expect(await recordingGps(page, "front"), "reopening the log preserves each recording's GPS once").toEqual(
        datedFrontGps(),
    );
    expect(await duplicatedTripFixes(page), "reopening the log preserves each trip fix once").toEqual([]);
}

/** Root logs pass through the real parser worker on hosted and file origins. */
export async function check70maiSessionGps(page: Page, directory: string, withGps: boolean): Promise<void> {
    writeSessionFolder(directory, withGps);
    const expected = [
        { name: RECORDING_NAME, ready: true, start: START_UTC, seconds: withGps ? [START_UTC + 1, START_UTC + 2] : [] },
        { name: OTHER_RECORDING_NAME, ready: true, start: START_UTC, seconds: [] },
    ];
    const recordingState = () => sessionRecordingState(page);
    await page.locator("#folder-input").setInputFiles(directory);
    await expect
        .poll(recordingState, {
            message: "the root GPS log binds only to descendant recording intervals after metadata is read",
            timeout: 30_000,
        })
        .toEqual(expected);

    await openRecordingTrip(page, RECORDING_NAME);
    if (withGps) {
        await expect(page.locator(".player-no-gps")).toBeHidden();
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        const recording = await page.evaluate((name) => {
            const candidate = window.__everydashcam.state.trips
                .flatMap((trip) => trip.frames.flatMap((frame) => Object.values(frame.channels)))
                .find((candidate) => candidate.file.name === name)!;
            return {
                start: candidate.startUtc,
                duration: candidate.durationSec,
                extractors: candidate.appliedExtractors,
                coordinates: candidate.records.map((record) => [record.lat, record.lon]),
            };
        }, RECORDING_NAME);
        expect(recording).toEqual({
            start: START_UTC,
            duration: 3,
            extractors: ["csv-70mai"],
            coordinates: [
                [56, 39],
                [56, 39],
            ],
        });
    } else {
        await expect(page.locator(".player-no-gps")).toBeVisible();
    }

    await page.locator("#folder-input").setInputFiles(directory);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return state.ingestController === null && state.readingTrips.size === 0;
            }),
        )
        .toBe(true);
    await expect
        .poll(recordingState, { message: "reopening a card preserves its scoped GPS without duplicates" })
        .toEqual(expected);
}

/** A manual camera zone reassigns raw GPS intervals independently of track shifts. */
export async function check70maiCameraTimezone(
    page: Page,
    directory: string,
    screenshotDirectory?: string,
): Promise<void> {
    writeSessionFolder(directory, true, true);
    if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });
    const browserStart = START_UTC - 2 * 3600;
    const expected = (zoneSec: number, hasGps: boolean) =>
        [
            {
                name: RECORDING_NAME,
                ready: true,
                start: START_UTC + 10800 - zoneSec,
                seconds: hasGps ? [START_UTC + 1, START_UTC + 2] : [],
            },
            {
                name: FOLLOWING_RECORDING_NAME,
                ready: true,
                start: START_UTC + 10800 - zoneSec + 3,
                seconds: hasGps ? [START_UTC + 4, START_UTC + 5] : [],
            },
            { name: OTHER_RECORDING_NAME, ready: true, start: browserStart, seconds: [] },
        ].sort((a, b) => a.name.localeCompare(b.name));
    const expectRecordingZone = async (zoneSec: number, hasGps: boolean) => {
        await expect
            .poll(() => sessionRecordingState(page), {
                message: "camera time zones rebind every descendant while leaving the sibling card unchanged",
                timeout: 30_000,
            })
            .toEqual(expected(zoneSec, hasGps));
    };
    const select = page.locator("#gps-sync-timezone-select");
    const reset = page.locator("#gps-sync-timezone-reset");
    const preview = page.locator("#gps-sync-timezone-preview");
    const offset = page.locator("#gps-sync-offset-input");
    const notification = page
        .locator("#toast-container .dc-toast")
        .filter({ hasText: /This folder has a GPS track|В папке есть GPS-трек/ });
    const expectEffectiveShift = async () => {
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const state = window.__everydashcam.state;
                    const trip = state.active ? state.trips[state.active.trip] : undefined;
                    if (!trip) return null;
                    return {
                        start: trip.startUtc,
                        offset: trip.gpsOffsetSec,
                        seconds: trip.records.map((record) => record.unixSeconds),
                    };
                }),
            )
            .toEqual({
                start: START_UTC,
                offset: 0.5,
                seconds: [1.5, 2.5, 4.5, 5.5].map((seconds) => START_UTC + seconds),
            });
    };

    await page.locator("#folder-input").setInputFiles(directory);
    await expectRecordingZone(18000, false);
    await openRecordingTrip(page, RECORDING_NAME);
    await expect(page.locator(".player-no-gps")).toBeVisible();
    await expect(page.locator("#gps-sync-pill")).toBeVisible();
    await expect(notification).toBeVisible();
    if (screenshotDirectory) {
        await page.screenshot({ path: join(screenshotDirectory, "timezone-unmatched-toast-desktop.png") });
        await page.setViewportSize(MOBILE);
        await expect(notification.locator(".dc-toast__action")).toBeInViewport();
        const fitsWidth = await notification.evaluate((toast) => {
            const rect = toast.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
        });
        expect(fitsWidth, "the unmatched GPS notice and action fit the phone viewport").toBe(true);
        await page.screenshot({ path: join(screenshotDirectory, "timezone-unmatched-toast-mobile.png") });
    }
    await notification.locator(".dc-toast__action").click();
    await expect(page.locator("#gps-sync-modal")).toBeVisible();
    if (screenshotDirectory) await page.setViewportSize(DESKTOP);
    await expect(select).toHaveValue("auto");
    await expect(reset).toBeDisabled();
    await expect(preview).toContainText("11:25:49");
    await expect(page.locator("#gps-sync-controls")).toBeHidden();
    await expect(page.locator("#gps-sync-timezone-no-match")).toBeVisible();
    if (screenshotDirectory) {
        await page.screenshot({ path: join(screenshotDirectory, "timezone-auto-desktop.png") });
    }
    await page.locator("#gps-sync-close").click();
    await openRecordingTrip(page, OTHER_RECORDING_NAME);
    await expect(page.locator("#gps-sync-pill")).toBeHidden();
    await openRecordingTrip(page, RECORDING_NAME);
    await expect(notification, "reopening a trip does not repeat the folder's GPS notice").toHaveCount(0);
    await page.locator("#folder-input").setInputFiles(directory);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.ingestController === null)).toBe(true);
    await expectRecordingZone(18000, false);
    await openRecordingTrip(page, OTHER_RECORDING_NAME);
    await openRecordingTrip(page, RECORDING_NAME);
    await expect(notification, "opening the folder again makes the GPS notice available once more").toBeVisible();
    await notification.locator(".dc-toast__action").click();

    await select.selectOption("10800");
    await expectRecordingZone(10800, true);
    await expect(reset).toBeEnabled();
    await expect(preview).toContainText("13:25:49");
    await expect(page.locator(".player-no-gps")).toBeHidden();
    await expect(page.locator("#gps-sync-timezone-no-match")).toBeHidden();
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await expect(offset).toHaveValue("0");
    await offset.fill("0.5");
    await offset.press("Enter");
    await expectRecordingZone(10800, true);
    await expectEffectiveShift();
    if (screenshotDirectory) {
        await page.screenshot({ path: join(screenshotDirectory, "timezone-manual-desktop.png") });
        await page.setViewportSize(MOBILE);
        await expect(page.locator("#gps-sync-modal")).toHaveAttribute("aria-modal", "true");
        await expect(page.locator(".gps-sync-card")).toBeInViewport({ ratio: 1 });
        const fitsWidth = await page.locator(".gps-sync-card").evaluate((card) => {
            const rect = card.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth && card.scrollWidth <= card.clientWidth;
        });
        expect(fitsWidth, "the camera time-zone controls fit the phone panel without horizontal overflow").toBe(true);
        await page.screenshot({ path: join(screenshotDirectory, "timezone-manual-mobile.png") });
        await page.locator("#gps-sync-close").scrollIntoViewIfNeeded();
        await expect(page.locator("#gps-sync-close")).toBeInViewport();
        await select.scrollIntoViewIfNeeded();
        await page.setViewportSize(DESKTOP);
    }

    await select.selectOption("20700");
    await expectRecordingZone(20700, false);
    await expect(preview).toContainText("10:40:49");
    await expect(page.locator(".player-no-gps")).toBeVisible();
    await select.selectOption("10800");
    await expectRecordingZone(10800, true);
    await expect(offset).toHaveValue("0.5");
    await expectEffectiveShift();
    await reset.click();
    await expect(select).toHaveValue("auto");
    await expectRecordingZone(18000, false);
    await expect(reset).toBeDisabled();
    await expect(page.locator(".player-no-gps")).toBeVisible();
    await expect(notification, "clock changes do not repeat the folder's GPS notice").toHaveCount(0);
    await select.selectOption("10800");
    await expectRecordingZone(10800, true);
    await expectEffectiveShift();
    await page.locator("#gps-sync-close").click();

    await page.reload();
    await page.locator("#folder-input").setInputFiles(directory);
    await expectRecordingZone(10800, true);
    await openRecordingTrip(page, RECORDING_NAME);
    await expectEffectiveShift();
    await page.locator("#gps-sync-pill").click();
    await expect(select).toHaveValue("10800");
    await expect(offset).toHaveValue("0.5");
    await page.locator("#gps-sync-close").click();

    await openRecordingTrip(page, OTHER_RECORDING_NAME);
    await expect(page.locator("#gps-sync-pill")).toBeHidden();
    await page.locator("#folder-input").setInputFiles(SAMPLE_GOPRO);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                // The closing metadata sweep can still reorder trip indices
                // after this recording becomes ready.
                return (
                    state.ingestController === null &&
                    state.recordingAnalysisProgress === null &&
                    state.trips.some((trip) =>
                        trip.frames.some((frame) =>
                            Object.values(frame.channels).some(
                                (candidate) => candidate.file.name === "hero5-trimmed.mp4" && candidate.metadataReady,
                            ),
                        ),
                    )
                );
            }),
        )
        .toBe(true);
    await openRecordingTrip(page, "hero5-trimmed.mp4");
    await expect(page.locator("#gps-sync-pill")).toBeVisible();
    await page.locator("#gps-sync-pill").click();
    await expect(page.locator("#gps-sync-timezone-section")).toBeHidden();
    await expect(offset).toHaveValue("0");
}

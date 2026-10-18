import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect } from "@playwright/test";

import { SAMPLE_70MAI, SAMPLE_NOGPS, masterVideoTime, pausePlayback } from "./_fixtures.js";

export type CopyOrder = "normal-first" | "event-first";

interface RecordingFile {
    name: string;
    mimeType: string;
    buffer: Buffer;
}

function recordingFiles(stamp: string): RecordingFile[] {
    return [
        ["Front", "F"],
        ["Back", "B"],
        ["Interior", "I"],
    ].map(([folder, channel]) => {
        const name = `NO20260101-${stamp}${channel}.MP4`;
        return {
            name,
            mimeType: "video/mp4",
            buffer: readFileSync(join(SAMPLE_70MAI, "Normal", folder!, name)),
        };
    });
}

const normal = recordingFiles("120000-000001");
const event = normal.map((file) => ({ ...file, name: file.name.replace(/^NO/, "EV") }));
const following = recordingFiles("120002-000002");
const gps: RecordingFile = {
    name: "GPSData000001.txt",
    mimeType: "text/plain",
    buffer: readFileSync(join(SAMPLE_70MAI, "GPSData000001.txt")),
};

/** File payload order is explicit; every pair reuses the same public synthetic bytes. */
async function importFiles(page: Page, files: RecordingFile[]): Promise<void> {
    await page.locator("#file-input").setInputFiles(files);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return state.lastIngestFiles?.map((file) => file.file.name).sort();
            }),
        )
        .toEqual(files.map((file) => file.name).sort());
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return state.ingestController === null && state.readingTrips.size === 0;
            }),
        )
        .toBe(true);
}

async function expectTrip(page: Page, firstMode: "normal" | "event", hasGps = true): Promise<void> {
    await expect(page.locator("li.trip:not(.unindexed-note)")).toHaveCount(1);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const trip = window.__everydashcam.state.trips[0];
                    if (!trip) return null;
                    const candidates = [...new Set(trip.frames.flatMap((frame) => Object.values(frame.channels)))];
                    return {
                        duration: trip.durationSec,
                        contentDuration: trip.timeline.contentDurationSec,
                        files: candidates.length,
                        indexed: candidates.every((candidate) => candidate.metadataReady === true),
                        segments: trip.timeline.segments.map((segment) => ({
                            start: segment.contentStart,
                            end: segment.contentEnd,
                            modes: Object.entries(trip.frames[segment.frameIndex]!.channels)
                                .map(([channel, candidate]) => [channel, candidate.recordingMode])
                                .sort(([a], [b]) => a!.localeCompare(b!)),
                        })),
                        gpsSeconds: trip.records.map((record) => record.unixSeconds - trip.startUtc),
                    };
                }),
            { message: "each three-camera recording occupies one interval with its original GPS" },
        )
        .toEqual({
            duration: 4,
            contentDuration: 4,
            files: 6,
            indexed: true,
            segments: [
                {
                    start: 0,
                    end: 2,
                    modes: [
                        ["front", firstMode],
                        ["interior", firstMode],
                        ["rear", firstMode],
                    ],
                },
                {
                    start: 2,
                    end: 4,
                    modes: [
                        ["front", "normal"],
                        ["interior", "normal"],
                        ["rear", "normal"],
                    ],
                },
            ],
            gpsSeconds: hasGps ? [0, 1, 2, 3, 4] : [],
        });
}

async function openPausedTrip(page: Page): Promise<void> {
    await page.locator("li.trip:not(.unindexed-note)").click();
    await pausePlayback(page);
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Home");
    await expect.poll(() => masterVideoTime(page)).toBeLessThan(0.1);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(0.5, 1);
}

export async function checkBatchCopies(page: Page, order: CopyOrder): Promise<void> {
    const pair = order === "normal-first" ? [...normal, ...event] : [...event, ...normal];
    await importFiles(page, [...pair, ...following, gps]);
    await expectTrip(page, "event");
    await expect(page.locator("#notif-drawer-list")).toContainText("combined 3 recording copies; event markers kept");
    await openPausedTrip(page);
    await expect(page.locator("#player-total")).toHaveText("0:04");
}

export async function checkAddedCopies(page: Page, order: CopyOrder): Promise<void> {
    const first = order === "normal-first" ? normal : event;
    const second = order === "normal-first" ? event : normal;
    await importFiles(page, [...first, ...following, gps]);
    await expectTrip(page, order === "normal-first" ? "normal" : "event");
    await openPausedTrip(page);

    await page.locator(".trip-edit").click();
    await page.locator("#trip-meta-name").fill("Marked drive");
    await page.locator("#trip-meta-note").fill("Keep the event and this note together");
    await page.locator("#trip-meta-save").click();
    const storage = page.locator("#notes-storage-modal");
    await expect(storage).toBeVisible();
    await storage.getByRole("button", { name: "Only in this browser", exact: true }).click();
    await expect(storage).toBeHidden();

    const before = await page.evaluate(() => ({
        active: window.__everydashcam.state.active,
        source: window.__everydashcam.dom.player.currentSrc,
        time: window.__everydashcam.dom.player.currentTime,
    }));
    await importFiles(page, second);
    await expectTrip(page, "event");
    await expect(page.locator("#notif-drawer-list")).toContainText("combined 3 recording copies; event markers kept");
    await expect(page.locator("#player-total")).toHaveText("0:04");
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    const after = await page.evaluate(() => ({
        active: window.__everydashcam.state.active,
        source: window.__everydashcam.dom.player.currentSrc,
        time: window.__everydashcam.dom.player.currentTime,
    }));
    expect(after.active, "adding only copies keeps the open frame").toEqual(before.active);
    expect(after.source, "adding only copies keeps the active video source").toBe(before.source);
    expect(after.time, "adding only copies keeps the playhead").toBeCloseTo(before.time, 3);
    await expect(page.locator("li.trip:not(.unindexed-note)")).toContainText("Marked drive");
    await page.locator(".trip-edit").click();
    await expect(page.locator("#trip-meta-note")).toHaveValue("Keep the event and this note together");
    await page.locator("#trip-meta-cancel").click();
}

export async function checkLateCopyGps(page: Page, malformedRecordingName = false): Promise<void> {
    await importFiles(page, [...event, ...following]);
    await expectTrip(page, "event", false);
    await importFiles(page, normal);
    await expectTrip(page, "event", false);
    // The sidecar names a collapsed NO alias, or the firmware's malformed VL
    // name that must resolve to the sole recording behind its confirmed copies.
    const sidecar = malformedRecordingName
        ? {
              ...gps,
              buffer: Buffer.from(
                  gps.buffer
                      .toString("utf8")
                      .replaceAll("NO20260101-120000-000001F.MP4", "VL20260101-120000-000001F.MP4G4"),
              ),
          }
        : gps;
    await importFiles(page, [sidecar]);
    await expectTrip(page, "event");
    await openPausedTrip(page);
    await expect(page.locator("#player-chart")).not.toHaveClass(/no-gps/);
}

export async function checkBlackVueCopies(page: Page): Promise<void> {
    const file: RecordingFile = {
        name: "20260101_120000_NF.mp4",
        mimeType: "video/mp4",
        buffer: readFileSync(join(SAMPLE_NOGPS, "clip-no-gps.mp4")),
    };
    const snapshot = () =>
        page.evaluate(() => {
            const { trips } = window.__everydashcam.state;
            const trip = trips[0];
            if (!trip) return null;
            const candidates = [...new Set(trip.frames.flatMap((frame) => Object.values(frame.channels)))];
            return {
                trips: trips.length,
                duration: trip.timeline.contentDurationSec,
                segments: trip.timeline.segments.length,
                files: candidates.map((candidate) => ({
                    channel: candidate.channel,
                    mode: candidate.recordingMode,
                    indexed: candidate.metadataReady === true,
                })),
            };
        });

    await importFiles(page, [file]);
    await expect.poll(snapshot).toEqual({
        trips: 1,
        duration: 3,
        segments: 1,
        files: [{ channel: "front", mode: "normal", indexed: true }],
    });
    await openPausedTrip(page);
    const source = await page.evaluate(() => window.__everydashcam.dom.player.currentSrc);
    const position = await masterVideoTime(page);

    await importFiles(page, [{ ...file, name: "20260101_120000_EF.mp4" }]);
    await expect.poll(snapshot).toEqual({
        trips: 1,
        duration: 3,
        segments: 1,
        files: [{ channel: "front", mode: "event", indexed: true }],
    });
    await expect(page.locator("#notif-drawer-list")).toContainText("combined 1 recording copy; event markers kept");
    await expect(page.locator("#player-total")).toHaveText("0:03");
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    expect(await page.evaluate(() => window.__everydashcam.dom.player.currentSrc)).toBe(source);
    expect(await masterVideoTime(page)).toBeCloseTo(position, 3);
}

export async function checkCopyGpxPreview(page: Page, cancel: boolean): Promise<void> {
    const buffer = readFileSync(join(SAMPLE_NOGPS, "clip-no-gps.mp4"));
    const names = ["LA20260101-120000-000001F.MP4", "NO20260101-120003-000002F.MP4", "LA20260101-120006-000003F.MP4"];
    const files = names.map((name) => ({ name, mimeType: "video/mp4", buffer }));
    const snapshot = () =>
        page.evaluate(() =>
            window.__everydashcam.state.trips.map((trip) => ({
                contentDuration: trip.timeline.contentDurationSec,
                files: [...new Set(trip.frames.flatMap((frame) => Object.values(frame.channels)))].map((candidate) => ({
                    name: candidate.file.name,
                    mode: candidate.recordingMode,
                    aliases: (candidate.recordingCopies ?? []).map((copy) => copy.file.name),
                    indexed: candidate.metadataReady === true,
                })),
            })),
        );
    const expectedFiles = names.map((name, index) => ({
        name,
        mode: index === 1 ? "normal" : "parking",
        aliases: [] as string[],
        indexed: true,
    }));
    const before = expectedFiles.map((file) => ({ contentDuration: 3, files: [file] }));
    await importFiles(page, files);
    await expect.poll(snapshot).toEqual(before);
    const start = await page.evaluate(() => window.__everydashcam.state.trips[0]!.startUtc);
    const points = [0, 4, 7].map(
        (seconds) =>
            `<trkpt lat="${50 + seconds * 0.0001}" lon="30"><time>${new Date((start + seconds) * 1000).toISOString()}</time></trkpt>`,
    );
    const copyName = "EV20260101-120003-000002F.MP4";
    await page.locator("#file-input").setInputFiles([
        { name: copyName, mimeType: "video/mp4", buffer },
        {
            name: "parking-route.gpx",
            mimeType: "application/gpx+xml",
            buffer: Buffer.from(`<gpx version="1.1"><trk><trkseg>${points.join("")}</trkseg></trk></gpx>`),
        },
    ]);

    const modal = page.locator("#gpx-assignment-modal");
    await expect(modal).toBeVisible();
    const assignment = page.locator(".gpx-assignment-select");
    await expect(assignment.locator('option:not([value=""])'), "GPX sees the future merged parking trip").toHaveCount(
        1,
    );
    expect(await snapshot(), "previewing the event upgrade leaves live candidates unchanged").toEqual(before);
    await expect(page.locator("#notif-drawer-list")).not.toContainText("recording copy; event markers kept");

    if (cancel) {
        const signal = await page.evaluateHandle(() => window.__everydashcam.state.ingestController!.signal);
        // The GPX modal covers the ingest Cancel button. Dispatch its existing
        // handler to exercise cancellation while the resolver is suspended.
        await page.locator("#ingest-overlay-cancel").dispatchEvent("click");
        expect(await signal.evaluate((signal) => signal.aborted)).toBe(true);
        await signal.dispose();
        await expect(modal).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.ingestController === null)).toBe(true);
        expect(await snapshot(), "cancelling discards pending modes and aliases").toEqual(before);
        await expect(page.locator("#notif-drawer-list")).not.toContainText("recording copy; event markers kept");
    } else {
        await assignment.selectOption({ index: 1 });
        await page.locator("#gpx-assignment-apply").click();
        await expect(modal).toBeHidden();
        expectedFiles[1] = { ...expectedFiles[1]!, mode: "event", aliases: [copyName] };
        await expect.poll(snapshot).toEqual([{ contentDuration: 9, files: expectedFiles }]);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.trips[0]!.records.length)).toBe(3);
        await expect(page.locator("#notif-drawer-list")).toContainText("combined 1 recording copy; event markers kept");
    }
}

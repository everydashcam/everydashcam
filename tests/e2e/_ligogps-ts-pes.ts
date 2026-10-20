import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { REPO_ROOT, expect, masterVideoTime, pausePlayback } from "./_fixtures.js";

// The camera's PMT types the GPS PID 0x82 (DTS in ATSC terms); without the
// AV-side mask the recording does not index or play.
const VIDEO = {
    name: "2026_10_18_130426_00.TS",
    mimeType: "video/mp2t",
    buffer: readFileSync(path.join(REPO_ROOT, "src/parsers/__fixtures__/ligogps-ts-pes/real-anonymized.TS")),
};
const LOG = {
    name: "2026_10_18_130426_00.TXT",
    mimeType: "text/plain",
    buffer: readFileSync(path.join(REPO_ROOT, "src/parsers/__fixtures__/ligogps-txt/real-anonymized.TXT")),
};

export async function checkLigoGpsTsPes(page: Page, withTxt: boolean): Promise<void> {
    await page.locator("#file-input").setInputFiles(withTxt ? [VIDEO, LOG] : [VIDEO]);
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().locator(".trip-title").click();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                const trip = state.active ? state.trips[state.active.trip] : undefined;
                if (!trip) return null;
                const records = trip.records;
                const onAnonymizedFix = records.every(
                    (record) => Math.abs(record.lat - 41) < 1e-5 && Math.abs(record.lon - 69) < 1e-5,
                );
                return onAnonymizedFix ? records.length : -1;
            }),
        )
        .toBe(withTxt ? 40 : 6);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return state.trips[state.active!.trip]!.frames[0]!.channels.front?.metadataReady;
            }),
        )
        .toBe(true);
    const indexed = await page.evaluate(() => {
        const state = window.__everydashcam.state;
        const recording = state.trips[state.active!.trip]!.frames[0]!.channels.front!;
        return { codec: recording.codec, codecString: recording.videoCodecString, durationSec: recording.durationSec };
    });
    expect(indexed.codec).toBe("hevc");
    expect(indexed.codecString).toBeTruthy();
    expect(indexed.durationSec).toBeGreaterThan(5);

    // HEVC is an OS capability and is often absent on Linux CI (see
    // docs/browser-support.md). Keep indexing/GPS coverage on those hosts and
    // require the supported degradation instead of attempting playback.
    const hevcSupported = await page.evaluate(async (codec) => {
        try {
            if (typeof VideoDecoder !== "undefined" && (await VideoDecoder.isConfigSupported({ codec })).supported) {
                return true;
            }
        } catch {
            // The native/MSE path can support HEVC even when WebCodecs cannot.
        }
        return (
            typeof MediaSource !== "undefined" &&
            MediaSource.isTypeSupported(`video/mp4; codecs="${codec.replace(/^hev1/, "hvc1")}"`)
        );
    }, indexed.codecString!);
    if (!hevcSupported) {
        await expect(page.locator(".viewer")).toHaveClass(/codec-unsupported/);
        await expect(page.locator("#codec-unsupported-state")).toBeVisible();
        return;
    }

    // Metadata and GPS can succeed while a separate MSE worker still cannot
    // decode the recording. Exercise that worker and a seek before playback.
    await expect(page.locator('#video-grid .video-tile[data-channel="front"]')).toBeVisible();
    await pausePlayback(page);
    const video = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
    expect(await video.evaluate((element: HTMLVideoElement) => [element.videoWidth, element.videoHeight])).toEqual([
        320, 180,
    ]);
    await video.evaluate((element: HTMLVideoElement) => {
        element.currentTime = 2;
    });
    await expect
        .poll(() =>
            video.evaluate(
                (element: HTMLVideoElement) =>
                    !element.seeking && element.readyState >= 2 && Math.abs(element.currentTime - 2) < 0.1,
            ),
        )
        .toBe(true);
    await page.locator("#player-play").click();
    await expect.poll(() => masterVideoTime(page)).toBeGreaterThan(2.2);
    await pausePlayback(page);
}

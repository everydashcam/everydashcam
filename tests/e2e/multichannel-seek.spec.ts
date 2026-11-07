import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import { expect, gotoApp, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";

let longGop: Uint8Array<ArrayBuffer>;
let shortGop: Uint8Array<ArrayBuffer>;

test.beforeAll(async () => {
    longGop = await createMseFixture({ format: "mpegts", gopDurationSec: 12, gopCount: 3 });
    shortGop = await createMseFixture({ format: "mpegts", gopCount: 36 });
});

function readChannels(page: Page) {
    return page
        .locator(".video-tile:not([hidden]) > video:not(.preload-slot)")
        .evaluateAll((videos: HTMLVideoElement[]) =>
            videos.map((video) => ({
                channel: video.closest<HTMLElement>(".video-tile")!.dataset.channel,
                time: video.currentTime,
                ready: video.readyState,
                seeking: video.seeking,
                paused: video.paused,
                buffered: Array.from({ length: video.buffered.length }, (_, i) => [
                    video.buffered.start(i),
                    video.buffered.end(i),
                ]),
            })),
        );
}

for (const bufferedChannel of ["front", "rear"]) {
    for (const isPlaying of [false, true]) {
        test(`seeks both TS cameras with only ${bufferedChannel} buffered while ${isPlaying ? "playing" : "paused"}`, async ({
            page,
        }) => {
            if (!isPlaying && bufferedChannel === "front") await page.clock.install();
            await presetLocalStorage(page);
            await gotoApp(page, "en");
            await page.locator("#file-input").setInputFiles(
                ["front", "rear"].map((channel) => ({
                    name: `20260904_202849${channel === "front" ? "F" : "R"}.ts`,
                    mimeType: "video/mp2t",
                    buffer: Buffer.from(channel === bufferedChannel ? longGop : shortGop),
                })),
            );
            const trips = page.locator("li.trip:not(.unindexed-note)");
            await expect(trips).toHaveCount(1);
            await trips.first().click();
            await expect
                .poll(async () => {
                    const channels = await readChannels(page);
                    return channels.length === 2 && channels.every((channel) => channel.ready >= 2);
                })
                .toBe(true);
            await pausePlayback(page);
            await expect
                .poll(async () => {
                    const channels = await readChannels(page);
                    return channels.map((channel) => ({
                        channel: channel.channel,
                        hasTarget: channel.buffered.some(([start, end]) => start! <= 10.8 && end! > 10.8),
                    }));
                })
                .toEqual([
                    { channel: "front", hasTarget: bufferedChannel === "front" },
                    { channel: "rear", hasTarget: bufferedChannel === "rear" },
                ]);
            if (isPlaying) {
                await page.locator("#player-play").click();
                await expect
                    .poll(async () => (await readChannels(page)).every((channel) => !channel.paused))
                    .toBe(true);
            }
            await page.keyboard.press("3");
            await expect
                .poll(
                    async () => {
                        const channels = await readChannels(page);
                        return channels.every(
                            (channel) =>
                                channel.ready >= 2 && !channel.seeking && channel.time >= 10.6 && channel.time < 14,
                        );
                    },
                    { message: "both cameras settle at the requested position", timeout: 4000 },
                )
                .toBe(true);
            if (!isPlaying && bufferedChannel === "front") {
                // The playhead pin expires after six seconds; it must expose the new position.
                await page.clock.fastForward(6500);
                await expect(page.locator("#player-mini-progress")).toHaveAttribute("aria-valuenow", "30");
                expect(
                    (await readChannels(page)).every(
                        (channel) => channel.paused && Math.abs(channel.time - 10.8) < 0.2,
                    ),
                ).toBe(true);
            }
            if (isPlaying) {
                await expect
                    .poll(async () =>
                        (await readChannels(page)).every((channel) => !channel.paused && channel.time > 11.8),
                    )
                    .toBe(true);
            }
        });
    }
}

import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";

import {
    DESKTOP,
    REPO_ROOT,
    boxOf,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

const SAMPLE = path.join(REPO_ROOT, "tests/testdata/asymmetric-channels");
const LIVE_VIDEO = "video:not(.preload-slot):not(.tile-blur-bg)";

function channelVideo(page: Page, channel: "front" | "interior") {
    return page.locator(`.video-tile[data-channel="${channel}"] > ${LIVE_VIDEO}`);
}

async function readChannels(page: Page) {
    return page.locator(`.video-tile:not([hidden]) > ${LIVE_VIDEO}`).evaluateAll((videos: HTMLVideoElement[]) =>
        videos.map((video) => ({
            channel: video.closest<HTMLElement>(".video-tile")!.dataset.channel,
            time: video.currentTime,
            duration: video.duration,
            ready: video.readyState,
            seeking: video.seeking,
            paused: video.paused,
        })),
    );
}

async function expectPosition(page: Page, seconds: number): Promise<void> {
    const frontTime = seconds < 78 ? seconds % 26 : seconds - 78;
    const interiorTime = seconds < 92 ? seconds : seconds - 92;
    await expect
        .poll(
            async () => {
                const channels = await readChannels(page);
                return channels
                    .map((channel) => {
                        const expectedTime = channel.channel === "front" ? frontTime : interiorTime;
                        return {
                            ...channel,
                            expectedTime,
                            canPlay: channel.ready >= 2,
                            inRange: Math.abs(channel.time - expectedTime) < 0.3,
                        };
                    })
                    .sort((a, b) => (a.channel ?? "").localeCompare(b.channel ?? ""));
            },
            { message: `both cameras show their original file offsets at trip second ${seconds}` },
        )
        .toEqual([
            expect.objectContaining({ channel: "front", canPlay: true, seeking: false, inRange: true }),
            expect.objectContaining({ channel: "interior", canPlay: true, seeking: false, inRange: true }),
        ]);
}

async function seekTo(page: Page, seconds: number): Promise<void> {
    // The whole-trip track maps the 104 s trip onto its own width.
    const bar = await boxOf(page, "#player-mini-progress");
    await page.mouse.click(bar.x + (bar.width * seconds) / 104, bar.y + bar.height / 2);
    await expectPosition(page, seconds);
}

async function makeInteriorMain(page: Page): Promise<void> {
    const interior = await boxOf(page, '.top-panel__channel-chip[data-channel="interior"]');
    const front = await boxOf(page, '.top-panel__channel-chip[data-channel="front"]');
    await page.mouse.move(interior.x + interior.width / 2, interior.y + interior.height / 2);
    await page.mouse.down();
    await page.mouse.move(interior.x + interior.width / 2 + 8, interior.y + interior.height / 2, { steps: 3 });
    await page.mouse.move(front.x + front.width / 2, front.y + front.height / 2, { steps: 8 });
    await expect(page.locator('.top-panel__channel-chip[data-channel="front"]')).toHaveClass(/drop-before/);
    await page.mouse.up();
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", "interior");
}

async function observeContinuingSource(page: Page, channel: "front" | "interior"): Promise<string> {
    return channelVideo(page, channel).evaluate((video: HTMLVideoElement, channel) => {
        video.dataset.boundaryObserver = channel;
        video.dataset.boundaryReloads = "0";
        for (const event of ["emptied", "loadstart"]) {
            video.addEventListener(event, () => {
                video.dataset.boundaryReloads = String(Number(video.dataset.boundaryReloads) + 1);
            });
        }
        return video.currentSrc;
    }, channel);
}

async function expectSourceUnchanged(page: Page, channel: "front" | "interior", source: string): Promise<void> {
    const video = channelVideo(page, channel);
    await expect(video).toHaveAttribute("data-boundary-observer", channel);
    await expect(video).toHaveAttribute("data-boundary-reloads", "0");
    expect(await video.evaluate((video: HTMLVideoElement) => video.currentSrc)).toBe(source);
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
    await installExportCapture(page);
    await gotoApp(page);
    await loadTrip(page, SAMPLE);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { trips } = window.__everydashcam.state;
                if (trips.length !== 1) return null;
                const trip = trips[0]!;
                const files = new Set(trip.frames.flatMap((frame) => Object.values(frame.channels)));
                return {
                    files: files.size,
                    indexed: [...files].every((file) => file.metadataReady === true),
                    duration: trip.durationSec,
                    contentDuration: trip.timeline.contentDurationSec,
                };
            }),
        )
        .toEqual({ files: 6, indexed: true, duration: 104, contentDuration: 104 });
    await expect(page.locator('.video-tile[data-channel="front"]')).toBeVisible();
    await expect(page.locator('.video-tile[data-channel="interior"]')).toBeVisible();
    await pausePlayback(page);
});

test("seeks both cameras and preserves the clock when the main camera changes", async ({ page }) => {
    // Clip rows exist only on an expanded card.
    await page.getByRole("button", { name: "Expand file list" }).click();
    await expect(page.locator(".trip-files > li").first()).toBeVisible();
    const names = await page.locator(".trip-files > li .file-name").allTextContents();
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size, "source files do not repeat for internal playback intervals").toBe(names.length);
    expect(names.some((name) => name.includes("120132_123_011_D.mp4"))).toBe(true);

    for (const seconds of [51, 80, 95]) await seekTo(page, seconds);

    await makeInteriorMain(page);
    await expectPosition(page, 95);
    await seekTo(page, 80);
});

test("seeks exactly to a new exterior file while the paused interior remains synchronized", async ({ page }) => {
    await seekTo(page, 10);
    await openExport(page);
    const interiorSource = await observeContinuingSource(page, "interior");
    const start = page.locator('.export-trim-bar__input[data-range-edge="start"]');
    await start.fill("26");
    await start.press("Enter");
    // Jump to the numeric mark-in so subpixel pointer rounding cannot turn
    // the exact file boundary into a tiny positive or negative seek offset.
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Shift+I");
    await expectPosition(page, 26);
    expect((await readChannels(page)).every((channel) => channel.paused)).toBe(true);
    await expectSourceUnchanged(page, "interior", interiorSource);
});

test("crosses an interior file boundary without reloading the exterior file", async ({ page }) => {
    await seekTo(page, 90);
    const exteriorSource = await observeContinuingSource(page, "front");
    await page.locator("#player-play").click();
    await expect
        .poll(
            async () => {
                const channels = await readChannels(page);
                const front = channels.find((channel) => channel.channel === "front");
                const interior = channels.find((channel) => channel.channel === "interior");
                return (
                    front !== undefined &&
                    interior !== undefined &&
                    !front.paused &&
                    !interior.paused &&
                    interior.duration === 12 &&
                    interior.time > 1 &&
                    interior.time < 8 &&
                    Math.abs(front.time - interior.time - 14) < 0.4
                );
            },
            { message: "the interior rolls over at 92 seconds while the exterior keeps its 78-second file" },
        )
        .toBe(true);
    await pausePlayback(page);
    await expectSourceUnchanged(page, "front", exteriorSource);
});

test("keeps the interior master playing while the exterior changes files", async ({ page }) => {
    await makeInteriorMain(page);
    await seekTo(page, 24);
    const interiorSource = await observeContinuingSource(page, "interior");
    await page.locator("#player-play").click();
    await expect
        .poll(
            async () => {
                const channels = await readChannels(page);
                const front = channels.find((channel) => channel.channel === "front");
                const interior = channels.find((channel) => channel.channel === "interior");
                return (
                    front !== undefined &&
                    interior !== undefined &&
                    !front.paused &&
                    !interior.paused &&
                    front.time > 1 &&
                    front.time < 8 &&
                    Math.abs(interior.time - front.time - 26) < 0.4
                );
            },
            { message: "the exterior rolls over at 26 seconds while the interior master keeps playing" },
        )
        .toBe(true);
    await pausePlayback(page);
    await expectSourceUnchanged(page, "interior", interiorSource);
});

test("opens the interior file from its sidebar row at its own start", async ({ page }) => {
    await page.getByRole("button", { name: "Expand file list" }).click();
    await page.locator(".trip-files > li .file-name").filter({ hasText: "120132_123_011_D.mp4" }).click();
    await page.waitForFunction(
        () => {
            const interior = document.querySelector<HTMLVideoElement>(
                '.video-tile[data-channel="interior"] > video:not(.preload-slot):not(.tile-blur-bg)',
            );
            return interior?.duration === 12 && interior.readyState >= 2 && !interior.seeking;
        },
        undefined,
        // A wrong earlier interval must not pass by playing through to this file.
        { timeout: 5_000 },
    );
    await pausePlayback(page);
    await expect
        .poll(async () => {
            const channels = await readChannels(page);
            const front = channels.find((channel) => channel.channel === "front");
            const interior = channels.find((channel) => channel.channel === "interior");
            return {
                channels,
                paused: channels.length === 2 && channels.every((channel) => channel.paused && !channel.seeking),
                // Sidebar activation starts playback before the pause control can run.
                nearStart: interior !== undefined && interior.time >= 0 && interior.time < 2,
                synchronized:
                    front !== undefined && interior !== undefined && Math.abs(front.time - interior.time - 14) < 0.3,
            };
        })
        .toMatchObject({ paused: true, nearStart: true, synchronized: true });
});

test("exports one continuous interior range across its file boundary", async ({ page }) => {
    await openExport(page);
    await page.locator('.top-panel__channel-chip[data-channel="front"] .top-panel__channel-include').uncheck();
    await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);
    for (const [edge, seconds] of [
        ["start", "88"],
        ["end", "98"],
    ]) {
        const input = page.locator(`.export-trim-bar__input[data-range-edge="${edge}"]`);
        await input.fill(seconds!);
        await input.press("Enter");
    }
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 30_000 });
    const bytes = await page.evaluate(() => {
        const handle = (window as unknown as { __lastExportHandle?: { _buf: Uint8Array } }).__lastExportHandle;
        if (!handle) throw new Error("export handle missing");
        return Array.from(handle._buf);
    });
    const output = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: [MP4] });
    const original = new Input({
        source: new BufferSource(readFileSync(path.join(SAMPLE, "InternalView/260101/120000_123_091_D.mp4"))),
        formats: [MP4],
    });
    try {
        const video = (await output.getPrimaryVideoTrack())!;
        expect(await video.computeDuration()).toBeCloseTo(10, 2);
        const first = (await new EncodedPacketSink(video).getFirstPacket())!;
        const source = new EncodedPacketSink((await original.getPrimaryVideoTrack())!);
        const expected = (await source.getKeyPacket(88, { verifyKeyPackets: true }))!;
        expect(expected.timestamp).toBe(88);
        expect(first.timestamp).toBeCloseTo(0, 3);
        expect(first.data, "the range starts from the original file's offset without re-encoding").toEqual(
            expected.data,
        );
    } finally {
        output.dispose();
        original.dispose();
    }
});

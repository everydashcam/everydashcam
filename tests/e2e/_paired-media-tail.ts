import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import { expectExportedPixelsCovered } from "./_export-pixels.js";
import { boxOf, expect, openExport, pausePlayback } from "./_fixtures.js";
import { showOnlyCameras } from "./_cameras.js";

const FRONT = "NO20260101-120000-000001F.MP4";
const REAR = "NO20260101-120000-000001B.MP4";
const START_UTC = Date.UTC(2026, 0, 1, 12) / 1000;
const ACTIVE_VIDEO = ".video-tile.active > video:not(.preload-slot)";

/** Real H.264 packets with a synthetic rear-only log whose clock is six seconds
 * ahead. No container clock is available to reconcile the conflicting anchors. */
async function loadPairedMediaTrip(page: Page): Promise<void> {
    const recordings = await Promise.all(
        [45, 46].map(async (duration) => Buffer.from(await createMseFixture({ gopCount: duration }))),
    );
    const rows = Array.from(
        { length: 47 },
        (_, i) => `${START_UTC + 6 + i - 8 * 3600},A,50,30,0,0,0,0,0,${REAR},0,0,0`,
    );
    await page.locator("#file-input").setInputFiles([
        { name: FRONT, mimeType: "video/mp4", buffer: recordings[0]! },
        { name: REAR, mimeType: "video/mp4", buffer: recordings[1]! },
        { name: "GPSData000001.txt", mimeType: "text/plain", buffer: Buffer.from(`$V02\n${rows.join("\n")}\n`) },
    ]);
    const card = page.locator("li.trip:not(.unindexed-note)").first();
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("aria-busy", "true");
    await card.locator(".trip-title").click();
    await expect(page.locator(ACTIVE_VIDEO)).toHaveJSProperty("readyState", 4);
    await pausePlayback(page);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const trip = window.__everydashcam.state.trips[0]!;
                const front = trip.frames[0]!.channels.front!;
                const rear = trip.frames[0]!.channels.rear!;
                return { skew: rear.startUtc - front.startUtc, source: rear.startSource };
            }),
        )
        .toEqual({ skew: 6, source: "gps" });
    await expect(page.locator("#player-total")).toHaveText("0:46");
}

async function seekPairedMedia(page: Page, seconds: number): Promise<void> {
    const bar = await boxOf(page, "#player-mini-progress");
    await page.mouse.click(bar.x + (bar.width * seconds) / 46, bar.y + bar.height / 2);
    await expect
        .poll(() => page.locator(ACTIVE_VIDEO).evaluate((v: HTMLVideoElement) => !v.seeking && v.currentTime))
        .toBeCloseTo(seconds, 1);
}

/** Rendered boxes of both camera tiles, rounded to whole pixels. */
async function tileBoxes(page: Page): Promise<Record<string, number[]>> {
    return page.locator(".video-grid").evaluate((grid) => {
        const boxes: Record<string, number[]> = {};
        for (const tile of grid.querySelectorAll<HTMLElement>(".video-tile:not([hidden])")) {
            const box = tile.getBoundingClientRect();
            boxes[tile.dataset.channel!] = [box.x, box.y, box.width, box.height].map(Math.round);
        }
        return boxes;
    });
}

export async function checkPairedMediaTail(page: Page): Promise<void> {
    await loadPairedMediaTrip(page);
    await seekPairedMedia(page, 44);
    const boxesBeforeTail = await tileBoxes(page);
    expect(Object.keys(boxesBeforeTail).sort()).toEqual(["front", "rear"]);
    await page.locator("#player-play").click();
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", "rear");
    await expect(page.locator(ACTIVE_VIDEO)).toHaveJSProperty("ended", true);
    await expect(page.locator(ACTIVE_VIDEO)).toHaveJSProperty("currentTime", 46);
    // The ended front camera holds its last frame in the primary slot while the
    // rear thumbnail plays as master; neither tile may swap looks.
    expect(await tileBoxes(page), "tile geometry through the held tail").toEqual(boxesBeforeTail);
    await seekPairedMedia(page, 45.5);
    await seekPairedMedia(page, 10);
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", "front");
}

async function drawRearZone(page: Page): Promise<void> {
    await page.locator(".export-panel__blur-add-btn").click();
    const layer = page.locator('.video-tile[data-channel="rear"] .blur-draw-layer');
    await expect(layer).toBeVisible();
    const content = await layer.evaluate((element) => {
        const video = element.closest(".video-tile")?.querySelector<HTMLVideoElement>("video:not(.preload-slot)");
        if (!video?.videoWidth) throw new Error("rear video unavailable");
        const box = element.getBoundingClientRect();
        const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
    });
    await page.mouse.move(content.x + content.width * 0.35, content.y + content.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(content.x + content.width * 0.65, content.y + content.height * 0.65, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator(".export-panel__blur-row")).toHaveCount(1);
    await expect(page.locator('.video-tile[data-channel="rear"] .blur-box:not([hidden])')).toBeVisible();
    await page.locator("#export-panel-blur-style").selectOption("fill");
    await expect
        .poll(() =>
            page.locator('.video-tile[data-channel="rear"] .blur-preview-canvas').evaluate((el: HTMLCanvasElement) => {
                const context = el.getContext("2d");
                if (!context || !el.width || !el.height) return null;
                return Array.from(context.getImageData(Math.floor(el.width / 2), Math.floor(el.height / 2), 1, 1).data);
            }),
        )
        .toEqual([0, 0, 0, 255]);
}

/** A rear mask must describe the same media frame in the editor and export,
 * including the final interval after the front camera has ended. */
export async function checkPairedMediaBlur(page: Page): Promise<void> {
    await loadPairedMediaTrip(page);
    await openExport(page);
    await showOnlyCameras(page, ["rear"]);
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", "rear");
    await seekPairedMedia(page, 45.5);
    await drawRearZone(page);
    await expect(page.locator(".export-panel__blur-row-range")).toHaveText("0:45-0:46");
    await page.locator(".export-panel__blur-del-btn").click();
    await expect(page.locator(".export-panel__blur-row")).toHaveCount(0);

    await seekPairedMedia(page, 10.25);
    await drawRearZone(page);
    await expect(page.locator(".export-panel__blur-row-range")).toHaveText("0:10-0:15");
    await page.locator("#export-panel-output").selectOption("720_16x9");
    await page.locator("#export-panel-audio").uncheck();
    for (const [edge, seconds] of [
        ["end", "12"],
        ["start", "11"],
    ] as const) {
        const input = page.locator(`.export-trim-bar__input[data-range-edge="${edge}"]`);
        await input.fill(seconds);
        await input.press("Enter");
    }
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });
    await expectExportedPixelsCovered(
        page,
        {
            inside: { x: 0.425, y: 0.425, w: 0.15, h: 0.15 },
            outside: [
                { x: 0.35, y: 0.2, w: 0.3, h: 0.1 },
                { x: 0.35, y: 0.7, w: 0.3, h: 0.1 },
            ],
        },
        [
            { name: "first covered rear frame", time: "first" },
            { name: "last covered rear frame", time: "last" },
        ],
        1,
    );
}

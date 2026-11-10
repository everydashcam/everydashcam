// Multi-camera export drawn by the layout engine: a blurred letterbox fills
// the space around the cameras with the main camera, and a camera without
// footage is a black tile while the others play.

import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import { chooseArrangementMode, makeMainFromMenu, setCameraShown } from "./_cameras.js";
import {
    DESKTOP,
    SAMPLE_70MAI,
    boxOf,
    canEncodeHighProfileH264,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

/** A rectangle as fractions of the output frame. */
interface Region {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Mean RGB of each region in the first frame of the captured export. */
async function exportedFirstFrameColors(page: Page, regions: Region[]): Promise<number[][]> {
    return page.evaluate(async (regions) => {
        const handle = (window as unknown as { __lastExportHandle: { _buf: Uint8Array } }).__lastExportHandle;
        const url = URL.createObjectURL(new Blob([handle._buf.slice()], { type: "video/mp4" }));
        const video = document.createElement("video");
        video.muted = true;
        try {
            await new Promise<void>((resolve, reject) => {
                video.onloadeddata = () => resolve();
                video.onerror = () => reject(new Error("exported video cannot play"));
                video.src = url;
            });
            // Seek within frame zero: loadeddata alone can precede a drawable image in Chromium.
            await new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
                video.currentTime = 0.000001;
            });
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(video, 0, 0);
            return regions.map((r) => {
                const data = ctx.getImageData(
                    Math.floor(r.x * canvas.width),
                    Math.floor(r.y * canvas.height),
                    Math.max(1, Math.ceil(r.w * canvas.width)),
                    Math.max(1, Math.ceil(r.h * canvas.height)),
                ).data;
                let red = 0;
                let green = 0;
                let blue = 0;
                for (let i = 0; i < data.length; i += 4) {
                    red += data[i]!;
                    green += data[i + 1]!;
                    blue += data[i + 2]!;
                }
                const count = data.length / 4;
                return [red / count, green / count, blue / count];
            });
        } finally {
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
        }
    }, regions);
}

/** Each visible tile as a fraction of the output frame the editor shows. */
async function previewTiles(page: Page): Promise<Record<string, Region>> {
    return page.evaluate(() => {
        const grid = document.querySelector("#video-grid")!.getBoundingClientRect();
        const tiles: Record<string, { x: number; y: number; w: number; h: number }> = {};
        for (const tile of document.querySelectorAll<HTMLElement>("#video-grid > .video-tile:not([hidden])")) {
            const r = tile.getBoundingClientRect();
            tiles[tile.dataset.channel!] = {
                x: (r.x - grid.x) / grid.width,
                y: (r.y - grid.y) / grid.height,
                w: r.width / grid.width,
                h: r.height / grid.height,
            };
        }
        return tiles;
    });
}

/** The middle of a region, away from edges that resampling softens. */
function middle(region: Region, margin = 0.3): Region {
    return {
        x: region.x + region.w * margin,
        y: region.y + region.h * margin,
        w: region.w * (1 - 2 * margin),
        h: region.h * (1 - 2 * margin),
    };
}

const brightness = (rgb: number[]): number => (rgb[0]! + rgb[1]! + rgb[2]!) / 3;

async function saveExport(page: Page): Promise<void> {
    await page.locator("#export-panel-watermark").uncheck();
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });
}

test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
    await presetLocalStorage(page);
    await installExportCapture(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
});

test("a blurred letterbox fills the space around equal cameras with the main one", async ({ page }) => {
    test.setTimeout(120_000);
    await loadTrip(page, SAMPLE_70MAI);
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode not available");
    await pausePlayback(page);
    await openExport(page);
    await setCameraShown(page, "interior", false);
    await chooseArrangementMode(page, "equal");
    await page.locator("#export-panel-blur").check();
    // Two 16:9 cameras in a 16:9 frame leave bands beside or above them
    // (side by side and stacked fit equally); one blurred layer paints them.
    const tiles = await previewTiles(page);
    const left = Math.min(...Object.values(tiles).map((tile) => tile.x));
    const top = Math.min(...Object.values(tiles).map((tile) => tile.y));
    expect(Math.max(left, top), "the cameras leave a band").toBeGreaterThan(0.1);
    const band: Region =
        top > left ? { x: 0.2, y: 0.02, w: 0.6, h: top - 0.04 } : { x: 0.02, y: 0.2, w: left - 0.04, h: 0.6 };
    await expect(page.locator("#video-grid > .grid-backdrop")).toBeVisible();
    await shot(page, "camera-export-01-blur-preview");

    await saveExport(page);
    const [background, front, rear] = await exportedFirstFrameColors(page, [
        band,
        middle(tiles.front!),
        middle(tiles.rear!),
    ]);
    expect(brightness(background!), "the band carries the blurred picture, not black").toBeGreaterThan(30);
    expect(brightness(front!), "the front camera has its picture").toBeGreaterThan(30);
    expect(brightness(rear!), "the rear camera has its picture").toBeGreaterThan(30);
});

/** A front camera recording 6 s and a rear camera that stops after 2.4 s. */
async function openShortRearTrip(page: Page): Promise<void> {
    const clips = await Promise.all([
        createMseFixture({ gopCount: 6 }),
        createMseFixture({ gopCount: 6, gopDurationSec: 0.4 }),
    ]);
    await page.locator("#file-input").setInputFiles(
        ["20260904_202849F", "20260904_202849R"].map((name, index) => ({
            name: `${name}.MP4`,
            mimeType: "video/mp4",
            buffer: Buffer.from(clips[index]!),
        })),
    );
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().locator(".trip-title").click();
    await expect(page.locator('.video-tile[data-channel="rear"]')).toBeVisible();
    await pausePlayback(page);
}

test("a camera without footage exports as a black tile beside a playing one", async ({ page }) => {
    test.setTimeout(120_000);
    await openShortRearTrip(page);
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode not available");
    await openExport(page);
    await chooseArrangementMode(page, "equal");
    for (const [edge, seconds] of [
        ["end", "5"],
        ["start", "3"],
    ] as const) {
        const input = page.locator(`.export-trim-bar__input[data-range-edge="${edge}"]`);
        await input.fill(seconds);
        await input.press("Enter");
    }
    // Inside the range, past the rear clip: the preview shows its black tile.
    const bar = await boxOf(page, "#player-mini-progress");
    await page.mouse.click(bar.x + (bar.width * 4) / 6, bar.y + bar.height / 2);
    await expect(page.locator('.video-tile[data-channel="rear"]')).toHaveClass(/\btile-absent\b/);
    const tiles = await previewTiles(page);
    await shot(page, "camera-export-02-absent-preview");

    await saveExport(page);
    const [front, rear] = await exportedFirstFrameColors(page, [middle(tiles.front!), middle(tiles.rear!)]);
    expect(brightness(front!), "the front camera has its picture").toBeGreaterThan(30);
    expect(brightness(rear!), "the rear camera without footage is black").toBeLessThan(8);
});

test("a main camera without footage in the whole range exports with the next camera in its place", async ({ page }) => {
    test.setTimeout(120_000);
    await openShortRearTrip(page);
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode not available");
    await openExport(page);
    await makeMainFromMenu(page, "rear");
    for (const [edge, seconds] of [
        ["end", "5"],
        ["start", "3"],
    ] as const) {
        const input = page.locator(`.export-trim-bar__input[data-range-edge="${edge}"]`);
        await input.fill(seconds);
        await input.press("Enter");
    }
    // Inside the range the rear camera has no footage: the front camera
    // stands in for it in the main place and the rear one is a black tile.
    const bar = await boxOf(page, "#player-mini-progress");
    await page.mouse.click(bar.x + (bar.width * 4) / 6, bar.y + bar.height / 2);
    const front = page.locator('.video-tile[data-channel="front"]');
    const rear = page.locator('.video-tile[data-channel="rear"]');
    await expect(rear).toHaveClass(/\btile-absent\b/);
    await expect(front).toHaveAttribute("data-role", "main");
    const tiles = await previewTiles(page);
    expect(tiles.front!.w * tiles.front!.h, "the stand-in gets the main place").toBeGreaterThan(
        tiles.rear!.w * tiles.rear!.h,
    );
    await shot(page, "camera-export-03-stand-in-preview");

    await saveExport(page);
    const [main, absent] = await exportedFirstFrameColors(page, [middle(tiles.front!), middle(tiles.rear!)]);
    expect(brightness(main!), "the stand-in fills the main place").toBeGreaterThan(30);
    expect(brightness(absent!), "the main camera without footage is black").toBeLessThan(8);
});

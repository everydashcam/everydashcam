import { resolve } from "node:path";
import { rolldown } from "rolldown";
import type { renderFlippedFrames } from "../helpers/camera-flip-harness.js";
import { omitModernBrowserApis } from "../helpers/legacy-browser-apis.js";
import {
    DESKTOP,
    MOBILE,
    REPO_ROOT,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    SCREENSHOT_DIR,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    readTranscodeDoneFields,
    test,
} from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

const COLOR_ERROR_LIMIT = 20;

function meanRgb(pixels: number[]): number[] {
    return [0, 1, 2].map(
        (channel) =>
            pixels.reduce((sum, value, index) => sum + (index % 4 === channel ? value : 0), 0) / (pixels.length / 4),
    );
}

function colorError(expected: number[], actual: number[]): number {
    return expected.reduce((sum, value, index) => sum + Math.abs(value - actual[index]!), 0) / 3;
}

test.describe("camera reflection", () => {
    test("camera menus work without Popover API on mobile and in fullscreen", async ({ page }) => {
        await omitModernBrowserApis(page);
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        const front = page.locator('.video-tile[data-channel="front"]');
        const frontButton = front.locator(".camera-settings-button");
        const rearButton = page.locator('.video-tile[data-channel="rear"] .camera-settings-button');
        const menu = page.locator("#camera-settings-front");
        await expect(menu).toBeHidden();
        await frontButton.click();
        await expect(menu).toBeVisible();
        await expect(frontButton).toHaveAttribute("aria-expanded", "true");
        await page.getByRole("menuitemcheckbox", { name: "Flip horizontally" }).click();
        await expect(front).toHaveClass(/camera-flipped/);
        await rearButton.click();
        await expect(menu).toBeHidden();
        await expect(frontButton).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByRole("menu")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(rearButton).toBeFocused();
        await frontButton.click();
        await page.locator("#player-mini-progress").click();
        await expect(menu).toBeHidden();
        await page.setViewportSize(MOBILE);
        await frontButton.click();
        await expect(menu).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: `${SCREENSHOT_DIR}/camera-flip-fallback-mobile.png` });
        await page.keyboard.press("Escape");
        await page.setViewportSize(DESKTOP);
        await page.locator("#player-fullscreen").click();
        await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
        await frontButton.click();
        await expect(page.locator("#player-wrap > #camera-settings-front")).toBeVisible();
        await expect(menu).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(frontButton).toBeFocused();
        await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    });

    test("composition reflects each video before overlays, crops and privacy masks", async ({ page }) => {
        const bundle = await rolldown({
            input: resolve(REPO_ROOT, "tests/helpers/camera-flip-harness.ts"),
            platform: "browser",
            resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
            transform: { define: { "import.meta.env": "{}", __PORTABLE__: "false" } },
        });
        let code: string;
        try {
            const output = await bundle.generate({ format: "es", codeSplitting: false });
            const chunk = output.output.find((entry) => entry.type === "chunk");
            if (!chunk) throw new Error("camera flip harness missing");
            code = chunk.code;
        } finally {
            await bundle.close();
        }
        await page.route("**/flip-harness.js", (route) =>
            route.fulfill({ contentType: "application/javascript", body: code }),
        );
        await page.route("**/flip-harness.html", (route) =>
            route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Camera reflection</title>" }),
        );
        await page.goto("/flip-harness.html");
        const result = await page.evaluate(async () => {
            const url = "/flip-harness.js";
            const module: { renderFlippedFrames: typeof renderFlippedFrames } = await import(url);
            return module.renderFlippedFrames();
        });
        const red = [255, 0, 0],
            green = [0, 255, 0],
            blue = [0, 0, 255],
            yellow = [255, 255, 0];
        expect(result.corners.map((frame) => frame.corners)).toEqual([
            [red, green, blue, yellow],
            [green, red, yellow, blue],
            [blue, yellow, red, green],
            [yellow, blue, green, red],
        ]);
        expect(result.corners.every((frame) => frame.overlay.every((value) => value === 255))).toBe(true);
        expect(result.crop).toEqual(yellow);
        expect(result.privacy).toEqual([yellow, [0, 0, 0]]);
        expect(result.mosaicAfter).toEqual(result.mosaicBefore);
        expect(result.mosaicAfter).toEqual(red);
        expect(result.split).toEqual([green, blue, blue, green]);
    });

    test("settings stay with the camera and channel across reloads and remain usable on mobile", async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        const front = page.locator('.video-tile[data-channel="front"]');
        const rear = page.locator('.video-tile[data-channel="rear"]');
        await front.locator(".camera-settings-button").click();
        await page.getByRole("menuitemcheckbox", { name: "Flip horizontally" }).click();
        await expect(front).toHaveClass(/camera-flipped/);
        await expect(rear).not.toHaveClass(/camera-flipped/);
        await page.keyboard.press("Escape");
        await expect(front.locator(".camera-settings-button")).toBeFocused();
        await page.reload();
        await loadTrip(page, SAMPLE_70MAI);
        await expect(front).toHaveClass(/camera-flipped/);
        await expect(rear).not.toHaveClass(/camera-flipped/);
        await front.locator(".camera-settings-button").click();
        await expect(page.getByRole("menuitemcheckbox", { name: "Flip horizontally" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await page.screenshot({ path: `${SCREENSHOT_DIR}/camera-flip-desktop.png` });
        await page.keyboard.press("Escape");
        await page.setViewportSize(MOBILE);
        await front.locator(".camera-settings-button").click();
        await expect(front.getByRole("menu")).toBeInViewport({ ratio: 1 });
        await page.getByRole("menuitemcheckbox", { name: "Flip vertically" }).click();
        await page.screenshot({ path: `${SCREENSHOT_DIR}/camera-flip-mobile.png` });
        await page.keyboard.press("Escape");
        await gotoApp(page, "ru");
        await loadTrip(page, SAMPLE_70MAI);
        await front.locator(".camera-settings-button").click();
        await expect(page.getByRole("menuitemcheckbox", { name: "Отразить по горизонтали" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await expect(page.getByRole("menuitemcheckbox", { name: "Отразить по вертикали" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await page.screenshot({ path: `${SCREENSHOT_DIR}/camera-flip-ru.png` });
    });

    test("three reflected cameras export a playable file with the expected pixels", async ({ page }) => {
        test.setTimeout(120_000);
        await presetLocalStorage(page);
        await installExportCapture(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        await page.locator("#player-mini-progress").focus();
        await page.keyboard.press("Home");
        const flips = [
            {
                channel: "front",
                horizontal: true,
                vertical: false,
                points: [
                    { x: 0.1, y: 0.2 },
                    { x: 0.55, y: 0.75 },
                ],
            },
            {
                channel: "rear",
                horizontal: false,
                vertical: true,
                points: [
                    { x: 0.45, y: 0.25 },
                    { x: 0.9, y: 0.45 },
                ],
            },
            {
                channel: "interior",
                horizontal: true,
                vertical: true,
                points: [
                    { x: 0.55, y: 0.25 },
                    { x: 0.1, y: 0.45 },
                ],
            },
        ];
        for (const flip of flips) {
            await page.locator(`.video-tile[data-channel="${flip.channel}"] .camera-settings-button`).click();
            if (flip.horizontal) await page.getByRole("menuitemcheckbox", { name: "Flip horizontally" }).click();
            if (flip.vertical) await page.getByRole("menuitemcheckbox", { name: "Flip vertically" }).click();
            await page.keyboard.press("Escape");
        }
        await openExport(page);
        await page.locator("#export-panel-watermark").uncheck();
        await expect
            .poll(() =>
                page
                    .locator(".video-tile:not([hidden]) video:not(.preload-slot):not(.tile-blur-bg)")
                    .evaluateAll((videos) =>
                        videos.every(
                            (v) =>
                                v instanceof HTMLVideoElement && v.readyState >= 2 && !v.seeking && v.currentTime < 0.1,
                        ),
                    ),
            )
            .toBe(true);
        const expected = await page.evaluate((flips) => {
            const grid = document.querySelector(".video-grid")!.getBoundingClientRect();
            return flips.flatMap((flip) => {
                const tile = document.querySelector(`.video-tile[data-channel="${flip.channel}"]`)!;
                const rect = tile.getBoundingClientRect();
                const video = tile.querySelector<HTMLVideoElement>("video:not(.preload-slot):not(.tile-blur-bg)")!;
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(video, 0, 0);
                const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
                const w = video.videoWidth * scale,
                    h = video.videoHeight * scale;
                // Use flat patches beside the fixture's diagonal stripe. Single source pixels
                // on its edges do not survive PiP resampling and software H.264 encoding.
                const size = 0.03;
                return flip.points.map(({ x, y }) => {
                    const left = x - size / 2,
                        top = y - size / 2;
                    const pixels = (horizontal: boolean, vertical: boolean) => [
                        ...ctx.getImageData(
                            Math.floor((horizontal ? 1 - left - size : left) * canvas.width),
                            Math.floor((vertical ? 1 - top - size : top) * canvas.height),
                            Math.ceil(size * canvas.width),
                            Math.ceil(size * canvas.height),
                        ).data,
                    ];
                    return {
                        channel: flip.channel,
                        x: (rect.left - grid.left + (rect.width - w) / 2 + left * w) / grid.width,
                        y: (rect.top - grid.top + (rect.height - h) / 2 + top * h) / grid.height,
                        width: (size * w) / grid.width,
                        height: (size * h) / grid.height,
                        pixels: pixels(flip.horizontal, flip.vertical),
                        withoutHorizontal: flip.horizontal ? pixels(false, flip.vertical) : null,
                        withoutVertical: flip.vertical ? pixels(flip.horizontal, false) : null,
                    };
                });
            });
        }, flips);
        for (const point of expected) {
            const rgb = meanRgb(point.pixels);
            for (const axis of ["withoutHorizontal", "withoutVertical"] as const) {
                const pixels = point[axis];
                if (pixels) {
                    expect(colorError(rgb, meanRgb(pixels)), `${point.channel}: ${axis}`).toBeGreaterThan(
                        2 * COLOR_ERROR_LIMIT,
                    );
                }
            }
        }
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });
        const regions = expected.map(({ x, y, width, height }) => ({ x, y, width, height }));
        const result = await page.evaluate(async (expected) => {
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
                return {
                    duration: video.duration,
                    samples: expected.map((point) => [
                        ...ctx.getImageData(
                            Math.floor(point.x * canvas.width),
                            Math.floor(point.y * canvas.height),
                            Math.ceil(point.width * canvas.width),
                            Math.ceil(point.height * canvas.height),
                        ).data,
                    ]),
                };
            } finally {
                video.removeAttribute("src");
                video.load();
                URL.revokeObjectURL(url);
            }
        }, regions);
        expect(result.duration).toBeCloseTo(4, 1);
        const colors = expected.map((point, index) => ({
            channel: point.channel,
            expected: meanRgb(point.pixels),
            actual: meanRgb(result.samples[index]!),
        }));
        expect(
            Math.max(...colors.map((point) => colorError(point.expected, point.actual))),
            JSON.stringify(colors),
        ).toBeLessThan(COLOR_ERROR_LIMIT);
    });

    test("a reflected single-camera export cannot bypass composition", async ({ page }) => {
        test.setTimeout(120_000);
        await presetLocalStorage(page);
        await installExportCapture(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_NOGPS);
        await page.locator(".video-tile:not([hidden]) .camera-settings-button").click();
        await page.getByRole("menuitemcheckbox", { name: "Flip horizontally" }).click();
        await page.keyboard.press("Escape");
        await openExport(page);
        await page.locator('input[name="export-panel-quality"][value="original"]').check();
        await page.locator("#export-panel-watermark").uncheck();
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });
        const done = await readTranscodeDoneFields(page);
        expect(done).not.toBeNull();
        expect(done!.framesEncoded).toBeGreaterThan(0);
        expect(done!.framesDirect).toBe(0);
    });
});

import { installWorkerRpc } from "./_worker-rpc.js";
import { resolve } from "node:path";
import type { DetectRequestData, DetectResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

test.use({ viewerMap: "route-only", reducedMotion: "reduce", serviceWorkers: "block" });

for (const locale of ["en", "ru"] as const)
    for (const [size, viewport] of [
        ["desktop", DESKTOP],
        ["mobile", MOBILE],
    ] as const) {
        test(`reviews independent detections as sections on ${locale} ${size}`, async ({ page }, info) => {
            await presetLocalStorage(page);
            await page.setViewportSize(viewport);
            await installWorkerRpc(
                page,
                (urls: string[]) => {
                    Object.defineProperty(navigator, "gpu", {
                        value: { requestAdapter: async () => ({}) },
                        configurable: true,
                    });
                    for (const url of urls) localStorage.setItem(`everydashcam:blurAssetDownloaded:${url}`, "1");
                    window.__workerRpc.intercept(["tracker-worker"], () => (type, data, forward) => {
                        if (type !== "detect") return forward();
                        const request = data as DetectRequestData;
                        const rect = { xPct: 0.2, yPct: 0.4, wPct: 0.1, hPct: 0.1 };
                        const first = request.segments[0]!;
                        const end = first.endInFile;
                        const unit = end / 8;
                        // Match the 30 fps fixture and WebCodecs' microsecond timestamps.
                        const sourceTime = (frame: number) => Math.round((frame * 1e6) / 30) / 1e6;
                        const frameTime = (value: number) =>
                            first.tripStart + sourceTime(Math.round(value * unit * 30));
                        const track = (from: number, to: number, bestScore: number, x = 0.2) => ({
                            startSec: frameTime(from),
                            endSec: frameTime(to),
                            detHits: 1,
                            bestScore,
                            keyframes: [{ contentSec: frameTime(from), rect: { ...rect, xPct: x } }],
                        });
                        const result: DetectResult = {
                            uncertainFramesByKind: { plate: [{ contentSec: frameTime(0.5), durationSec: 1 / 30 }] },
                            tracksByKind: {
                                plate:
                                    first.tripStart === 0
                                        ? [
                                              track(1, 4, 0.8),
                                              track(1, 4, 0.75, 0.8),
                                              track(4, 6, 0.9, 0.6),
                                              track(6.5, 8, 0.8),
                                          ]
                                        : [track(1, 1 + 1 / (30 * unit), 0.8)],
                            },
                            sourceFrames: Array.from({ length: Math.ceil(end * 30) }, (_, i) => ({
                                contentSec: first.tripStart + sourceTime(i),
                                durationSec: 1 / 30,
                            })),
                            statsByKind: {},
                            decodedFrames: 0,
                            passMs: 0,
                        };
                        const expectedFrames = JSON.parse(
                            document.documentElement.dataset.reviewFrames ?? "[]",
                        ) as number[];
                        expectedFrames.push(
                            ...(first.tripStart === 0 ? [frameTime(1), frameTime(6.5)] : [frameTime(1)]),
                        );
                        document.documentElement.dataset.reviewFrames = JSON.stringify(expectedFrames);
                        const uncertainFrames = JSON.parse(
                            document.documentElement.dataset.uncertainFrames ?? "[]",
                        ) as number[];
                        uncertainFrames.push(frameTime(0.5));
                        document.documentElement.dataset.uncertainFrames = JSON.stringify(uncertainFrames);
                        return result;
                    });
                },
                computeTrackerAssets("build").urls,
            );
            await gotoApp(page, locale);
            await loadTrip(page, resolve(SAMPLE_70MAI, "Normal/Front"));
            await pausePlayback(page);
            // Observe real compositor submissions on both physical video slots,
            // including promotion when review crosses a source-file boundary.
            await page
                .locator('.video-tile[data-channel="front"] video:not(.tile-blur-bg)')
                .evaluateAll((videos: HTMLVideoElement[]) => {
                    for (const video of videos) {
                        const observe: VideoFrameRequestCallback = (_, metadata) => {
                            video.dataset.reviewPresentedTime = String(metadata.mediaTime);
                            video.dataset.reviewPresentedSrc = video.currentSrc;
                            video.requestVideoFrameCallback(observe);
                        };
                        video.requestVideoFrameCallback(observe);
                    }
                });
            await openExport(page);
            await page.locator("#export-panel-blur-plates").check();
            const status = page.locator(".export-panel__blur-detect-status");
            await expect(status).toContainText(locale === "en" ? "Sections with plates: 3" : "Участки с номерами: 3");
            const frames = await page.evaluate(
                () => JSON.parse(document.documentElement.dataset.reviewFrames!) as number[],
            );
            const review = status.getByRole("button", {
                name: locale === "en" ? "Review findings" : "Проверить найденное",
            });
            for (const sec of [...frames, frames[0]!]) {
                await page
                    .locator('.video-tile[data-channel="front"] video:not(.tile-blur-bg)')
                    .evaluateAll((videos: HTMLVideoElement[]) => {
                        for (const video of videos) delete video.dataset.reviewPresentedTime;
                    });
                await review.click();
                const mediaTime = sec % 2;
                await expect
                    .poll(() =>
                        page.evaluate((mediaTime) => {
                            const { dom, state } = window.__everydashcam;
                            return {
                                mediaTime: Number(dom.player.dataset.reviewPresentedTime),
                                frameIndex: state.active?.frame,
                                insideFirstFrame:
                                    dom.player.currentTime > mediaTime && dom.player.currentTime < mediaTime + 1 / 30,
                                settled:
                                    dom.player.readyState >= 2 &&
                                    !dom.player.seeking &&
                                    dom.player.dataset.reviewPresentedSrc === dom.player.currentSrc,
                            };
                        }, mediaTime),
                    )
                    .toEqual({
                        mediaTime: expect.closeTo(mediaTime, 5),
                        frameIndex: Math.floor(sec / 2),
                        insideFirstFrame: true,
                        settled: true,
                    });
                const preview = page.locator('.video-tile[data-channel="front"] .blur-preview-canvas');
                await expect
                    .poll(() =>
                        preview.evaluate((canvas: HTMLCanvasElement) => {
                            const pixels = canvas
                                .getContext("2d")!
                                .getImageData(0, 0, canvas.width, canvas.height).data;
                            return pixels.some((value, index) => index % 4 === 3 && value > 0);
                        }),
                    )
                    .toBe(true);
            }
            const uncertain = status.getByRole("button", {
                name: locale === "en" ? "Check possible misses (2)" : "Проверить возможные пропуски (2)",
            });
            const uncertainFrames = await page.evaluate(
                () => JSON.parse(document.documentElement.dataset.uncertainFrames!) as number[],
            );
            for (const sec of uncertainFrames) {
                await uncertain.click();
                await expect
                    .poll(() =>
                        page.evaluate(() => ({
                            time: Number(window.__everydashcam.dom.player.dataset.reviewPresentedTime),
                            frame: window.__everydashcam.state.active?.frame,
                        })),
                    )
                    .toEqual({ time: expect.closeTo(sec % 2, 5), frame: Math.floor(sec / 2) });
            }
            expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
            await status.screenshot({ path: info.outputPath("detection-review.png") });
        });
    }

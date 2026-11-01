import { installWorkerRpc } from "./_worker-rpc.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import {
    expect,
    gotoApp,
    loadTrip,
    pausePlayback,
    presetLocalStorage,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    shot,
    test,
} from "./_fixtures.js";

interface RecoveryFault {
    remaining: number;
    failNextSeek: boolean;
    seekFailures: { target: number; reportedTime: number }[];
    requests: { file: string; startSec: number }[];
    emitFailure: () => void;
    retiredFailure: (() => void) | null;
}

declare global {
    interface Window {
        playbackRecoveryFault: RecoveryFault;
    }
}

let fixtureDirectory: string;

test.use({ serviceWorkers: "block" });

test.beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "everydashcam-playback-recovery-"));
    await mkdir(join(fixtureDirectory, "single"));
    await writeFile(
        join(fixtureDirectory, "single", "clip.mkv"),
        await createMseFixture({ format: "matroska", gopCount: 30 }),
    );
    await mkdir(join(fixtureDirectory, "seek"));
    await writeFile(
        join(fixtureDirectory, "seek", "clip.mkv"),
        await createMseFixture({ format: "matroska", gopCount: 90 }),
    );
    const native = await createMseFixture({ gopCount: 60 });
    for (const [folder, suffix] of [
        ["Front", "F"],
        ["Back", "B"],
    ]) {
        const directory = join(fixtureDirectory, "multiple", "Normal", folder!);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `NO20260101-120000-000001${suffix}.MP4`), native);
    }
});

test.afterAll(async () => {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

async function installMseFailure(page: Page, remaining = 0): Promise<void> {
    await installWorkerRpc(
        page,
        (remaining) => {
            const fault: RecoveryFault = {
                remaining,
                failNextSeek: false,
                seekFailures: [],
                requests: [],
                emitFailure: () => {
                    throw new Error("mse worker not attached");
                },
                retiredFailure: null,
            };
            window.playbackRecoveryFault = fault;
            window.__workerRpc.intercept(["per-file-mse-worker"], (worker) => {
                fault.emitFailure = () => {
                    void worker.notify("error", { reason: "injected-playback-fault" });
                };
                return (type, payload, forward) => {
                    if (type === "init") {
                        const data = payload as { file: File; startSec: number };
                        fault.requests.push({ file: data.file.name, startSec: data.startSec });
                    }
                    if (type === "seek" && fault.failNextSeek) {
                        fault.failNextSeek = false;
                        const target = (payload as { startSec: number }).startSec;
                        const emitFailure = fault.emitFailure;
                        queueMicrotask(() => {
                            const video = document.querySelector<HTMLVideoElement>("#player")!;
                            fault.seekFailures.push({ target, reportedTime: video.currentTime });
                            Reflect.deleteProperty(video, "currentTime");
                            emitFailure();
                        });
                        return;
                    }
                    // Metadata and MSE attachment stay real; inject only the feed failure.
                    if (type === "start-feed" && fault.remaining > 0) {
                        fault.remaining--;
                        queueMicrotask(fault.emitFailure);
                        return;
                    }
                    return forward();
                };
            });
        },
        remaining,
    );
}

for (const locale of ["en", "ru"]) {
    test(`offers a localized retry and preserves position after playback failure (${locale})`, async ({ page }) => {
        await presetLocalStorage(page);
        await installMseFailure(page);
        await gotoApp(page, locale);
        await loadTrip(page, join(fixtureDirectory, "single"));
        await expect
            .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => v.readyState))
            .toBeGreaterThanOrEqual(2);
        await page.locator("#player").evaluate((v: HTMLVideoElement) => {
            v.pause();
            v.currentTime = 7;
        });
        await expect
            .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => !v.seeking && v.currentTime))
            .toBe(7);
        await page.evaluate(() => {
            window.playbackRecoveryFault.remaining = 1;
            window.playbackRecoveryFault.emitFailure();
        });
        await expect(page.locator(".viewer")).toHaveClass(/playback-failed/);
        await expect(page.locator(".viewer")).not.toHaveClass(/codec-unsupported/);
        await expect(page.locator("#codec-unsupported-title")).toHaveText(
            locale === "en" ? "Couldn't play this video" : "Не удалось воспроизвести видео",
        );
        await expect(page.locator("#playback-failed-retry")).toHaveText(locale === "en" ? "Try again" : "Повторить");
        expect(
            await page.evaluate(
                () =>
                    window.__everydashcam.state.trips[window.__everydashcam.state.active!.trip]!.frames[0]!.channels
                        .front!.canPlay,
            ),
        ).toBe(true);
        expect(
            await page.evaluate(() => window.playbackRecoveryFault.requests.map((request) => request.startSec)),
        ).toEqual([0, 7]);
        await shot(page, `playback-failed-${locale}`);
        await page.locator("#playback-failed-retry").click();
        await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
        await expect
            .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => v.readyState))
            .toBeGreaterThanOrEqual(2);
        expect(
            await page
                .locator("#player")
                .evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, paused: v.paused })),
        ).toEqual({ time: 7, paused: true });
        expect(
            await page.evaluate(() => window.playbackRecoveryFault.requests.map((request) => request.startSec)),
        ).toEqual([0, 7, 7]);
    });
}

test("restores the collapsed trip list when playback fails so another trip can be opened", async ({ page }) => {
    await presetLocalStorage(page);
    await installMseFailure(page);
    await gotoApp(page, "en");
    await loadTrip(page, join(fixtureDirectory, "single"));
    await expect
        .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => v.readyState))
        .toBeGreaterThanOrEqual(2);
    await pausePlayback(page);
    await page.locator("#folder-input").setInputFiles(SAMPLE_NOGPS);
    await expect(page.locator("li.trip:not(.unindexed-note)")).toHaveCount(2);
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.evaluate(() => {
        window.playbackRecoveryFault.remaining = 1;
        window.playbackRecoveryFault.emitFailure();
    });
    await expect(page.locator(".viewer")).toHaveClass(/playback-failed/);
    await expect(page.locator("#sidebar")).toBeVisible();
    const nativeTrip = await page.evaluate(() =>
        window.__everydashcam.state.trips.findIndex((trip) =>
            trip.frames.some((frame) => frame.channels.front?.file.name.endsWith(".mp4")),
        ),
    );
    expect(nativeTrip).toBeGreaterThanOrEqual(0);
    await page.locator(`li.trip[data-trip-index="${nativeTrip}"] .trip-header`).click();
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("retries a failed backward seek at its requested position instead of the old media time", async ({ page }) => {
    await presetLocalStorage(page);
    await installMseFailure(page);
    await gotoApp(page, "en");
    await loadTrip(page, join(fixtureDirectory, "seek"));
    const video = page.locator("#player");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    const target = await page.evaluate(() => {
        const state = window.__everydashcam.state;
        return state.trips[state.active!.trip]!.timeline.contentDurationSec / 10;
    });
    // Move the MSE window forward before the backward seek, so its target is outside
    // the buffer and requires the worker's SEEK path.
    await page.keyboard.press("2");
    await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2 && v.currentTime))
        .toBeCloseTo(target * 2, 5);
    await video.evaluate((v: HTMLVideoElement) => {
        v.currentTime = 20;
    });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.currentTime)).toBe(20);
    await video.evaluate((v: HTMLVideoElement, target) => {
        const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
        window.playbackRecoveryFault.failNextSeek = true;
        window.playbackRecoveryFault.remaining = 1;
        // Simulate the browser retaining its old media clock until the new
        // fragment arrives. The SEEK notification fails before that fragment.
        Object.defineProperty(v, "currentTime", {
            configurable: true,
            get: () => currentTime.get!.call(v),
            set: (seconds: number) => {
                if (window.playbackRecoveryFault.failNextSeek && Math.abs(seconds - target) < 0.000001) return;
                currentTime.set!.call(v, seconds);
            },
        });
    }, target);
    await page.keyboard.press("1");
    await expect(page.locator(".viewer")).toHaveClass(/playback-failed/);
    expect(await page.evaluate(() => window.playbackRecoveryFault.seekFailures)).toEqual([
        { target, reportedTime: 20 },
    ]);
    expect(await page.evaluate(() => window.playbackRecoveryFault.requests.map((request) => request.startSec))).toEqual(
        [0, target],
    );
    await page.locator("#playback-failed-retry").click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    const restored = await video.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, paused: v.paused }));
    expect(restored.time).toBeCloseTo(target, 5);
    expect(restored.paused).toBe(true);
    expect(await page.evaluate(() => window.playbackRecoveryFault.requests.map((request) => request.startSec))).toEqual(
        [0, target, target],
    );
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
});

test("leaves a failed trip without letting its retired worker interrupt the next trip", async ({ page }) => {
    await presetLocalStorage(page);
    await installMseFailure(page, 2);
    await gotoApp(page, "en");
    await loadTrip(page, join(fixtureDirectory, "single"));
    await expect(page.locator(".viewer")).toHaveClass(/playback-failed/);
    await page.evaluate(() => {
        window.playbackRecoveryFault.retiredFailure = window.playbackRecoveryFault.emitFailure;
    });
    await page.locator("#folder-input").setInputFiles(SAMPLE_NOGPS);
    await expect(page.locator("li.trip:not(.unindexed-note)")).toHaveCount(2);
    const nativeTrip = await page.evaluate(() =>
        window.__everydashcam.state.trips.findIndex((trip) =>
            trip.frames.some((frame) => frame.channels.front?.file.name.endsWith(".mp4")),
        ),
    );
    expect(nativeTrip).toBeGreaterThanOrEqual(0);
    await page.locator(`li.trip[data-trip-index="${nativeTrip}"] .trip-header`).click();
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
    await expect
        .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => v.readyState))
        .toBeGreaterThanOrEqual(2);
    const source = await page.locator("#player").getAttribute("src");
    await page.evaluate(() => {
        window.playbackRecoveryFault.retiredFailure?.();
        document.getElementById("playback-failed-retry")?.click();
    });
    expect(await page.locator("#player").getAttribute("src")).toBe(source);
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
    expect(await page.evaluate(() => window.playbackRecoveryFault.requests)).toHaveLength(2);
});

test("retries a failed slave while the healthy camera keeps playing", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    await loadTrip(page, join(fixtureDirectory, "multiple"));
    await expect
        .poll(() => page.locator("#player-rear").evaluate((v: HTMLVideoElement) => v.readyState))
        .toBeGreaterThanOrEqual(2);
    await expect
        .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => v.currentTime))
        .toBeGreaterThan(0.1);
    const healthy = await page
        .locator("#player")
        .evaluate((v: HTMLVideoElement) => ({ source: v.src, time: v.currentTime }));
    await page.evaluate(() => {
        const rear = document.querySelector<HTMLVideoElement>("#player-rear")!;
        const fail = (video: HTMLMediaElement): void => {
            Object.defineProperty(video, "error", {
                configurable: true,
                value: { code: MediaError.MEDIA_ERR_DECODE, message: "injected native playback fault" },
            });
            video.dispatchEvent(new Event("error"));
            Reflect.deleteProperty(video, "error");
        };
        let remaining = 1;
        const load = HTMLMediaElement.prototype.load;
        HTMLMediaElement.prototype.load = function () {
            load.call(this);
            if (this === rear && this.hasAttribute("src") && remaining > 0) {
                remaining--;
                queueMicrotask(() => fail(this));
            }
        };
        fail(rear);
    });
    await expect(page.locator('[data-channel="rear"] .tile-playback-retry')).toBeVisible();
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
    expect(await page.locator("#player").evaluate((v: HTMLVideoElement) => v.src)).toBe(healthy.source);
    await expect
        .poll(() => page.locator("#player").evaluate((v: HTMLVideoElement) => v.currentTime))
        .toBeGreaterThan(healthy.time + 0.3);
    expect(
        await page.evaluate(
            () =>
                window.__everydashcam.state.trips[window.__everydashcam.state.active!.trip]!.frames[0]!.channels.rear!
                    .canPlay,
        ),
    ).toBe(true);
    await shot(page, "playback-failed-slave");
    await page.locator('[data-channel="rear"] .tile-playback-retry').click();
    await expect(page.locator('[data-channel="rear"] .tile-playback-retry')).toHaveCount(0);
    await expect
        .poll(() => page.locator("#player-rear").evaluate((v: HTMLVideoElement) => v.readyState))
        .toBeGreaterThanOrEqual(2);
    expect(await page.locator("#player").evaluate((v: HTMLVideoElement) => v.src)).toBe(healthy.source);
});

test("moves on to the next clip when the decoder fails in the current clip's tail", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    // A real two-clip, three-camera trip: the clip boundary the tail failure
    // has to cross, with slaves that reload behind the master.
    await loadTrip(page, SAMPLE_70MAI);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.trips[0]?.frames.length ?? 0)).toBe(2);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.active?.frame ?? -1)).toBe(0);
    const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
    await expect.poll(() => master.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime)).toBeGreaterThan(0.1);
    // Paused, so the 2 s fixture clip cannot reach its natural end during the
    // check: only the injected failure can move the player to the next clip.
    await pausePlayback(page);
    const firstSource = await master.evaluate((v: HTMLVideoElement) => v.currentSrc);
    // A truncated final GOP: the decoder gives up a second before the indexed
    // end. Report that position through the element the player consults.
    await master.evaluate((video: HTMLVideoElement) => {
        const duration = video.duration;
        Object.defineProperty(video, "currentTime", { configurable: true, get: () => duration - 1 });
        Object.defineProperty(video, "error", {
            configurable: true,
            value: { code: MediaError.MEDIA_ERR_DECODE, message: "injected tail decode fault" },
        });
        video.dispatchEvent(new Event("error"));
        Reflect.deleteProperty(video, "error");
        Reflect.deleteProperty(video, "currentTime");
    });
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.active?.frame ?? -1)).toBe(1);
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
    await expect
        .poll(() => master.evaluate((v: HTMLVideoElement) => v.currentSrc !== "" && v.currentSrc))
        .not.toBe(firstSource);
    // The user had paused: the next clip is ready but does not start on its own.
    await expect.poll(() => master.evaluate((v: HTMLVideoElement) => v.paused && v.readyState >= 2)).toBe(true);
    await master.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => master.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime)).toBeGreaterThan(0.05);
    expect(
        await page.evaluate(() =>
            window.__everydashcam.state.trips[0]!.frames.every((frame) => frame.channels.front?.canPlay === true),
        ),
        "a tail failure is not a codec rejection",
    ).toBe(true);
});

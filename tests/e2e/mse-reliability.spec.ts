import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import {
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

let fixtureDirectory: string;

interface QuotaFault {
    injected: boolean;
    retries: number;
    bufferedEnd: number;
    futureRemovals: number;
}

async function installQuotaFault(page: Page, minimumBufferedEnd = 6): Promise<void> {
    await page.evaluate((minimumBufferedEnd) => {
        const fault: QuotaFault = { injected: false, retries: 0, bufferedEnd: 0, futureRemovals: 0 };
        Object.assign(window, { mseQuotaFault: fault });
        const append = SourceBuffer.prototype.appendBuffer;
        const remove = SourceBuffer.prototype.remove;
        let rejected: Parameters<SourceBuffer["appendBuffer"]>[0] | null = null;
        SourceBuffer.prototype.appendBuffer = function (data) {
            if (data === rejected) fault.retries++;
            if (!fault.injected && this.buffered.length > 0 && this.buffered.end(0) >= minimumBufferedEnd) {
                fault.injected = true;
                fault.bufferedEnd = this.buffered.end(0);
                rejected = data;
                throw new DOMException("injected SourceBuffer capacity fault", "QuotaExceededError");
            }
            return append.call(this, data);
        };
        SourceBuffer.prototype.remove = function (start, end) {
            const video = document.querySelector<HTMLVideoElement>("#player");
            if (video && end > video.currentTime) fault.futureRemovals++;
            return remove.call(this, start, end);
        };
    }, minimumBufferedEnd);
}

function readQuotaFault(page: Page): Promise<QuotaFault> {
    return page.evaluate(() => (window as Window & { mseQuotaFault?: QuotaFault }).mseQuotaFault!);
}

test.beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "everydashcam-mse-browser-"));
    for (const [name, options] of [
        ["long-gop", { gopDurationSec: 10, gopCount: 3 }],
        ["short-audio", { audioDurationSec: 0.4 }],
        ["seek-zero", { gopCount: 120, preserveFrameTiming: true }],
        // Audio starts a second before video, and the stretched frame timing
        // puts several audio samples between a GOP's last frame and the next
        // keyframe: the muxer emits those as fragments without video samples,
        // before the first keyframe and at every GOP boundary.
        ["audio-leading", { gopDurationSec: 10, gopCount: 3, audioDurationSec: 31, audioLeadSec: 1 }],
        ["matched-audio", { gopCount: 2, audioDurationSec: 2 }],
        ["plain", { gopCount: 2 }],
        ["mirrored", { gopCount: 2, videoMetadata: { flip: true } }],
    ] as const) {
        const directory = join(fixtureDirectory, name);
        await mkdir(directory);
        await writeFile(join(directory, "clip.mkv"), await createMseFixture({ ...options, format: "matroska" }));
    }
    const tsDirectory = join(fixtureDirectory, "ts-audio");
    await mkdir(tsDirectory);
    await writeFile(
        join(tsDirectory, "clip.ts"),
        await createMseFixture({ format: "mpegts", gopCount: 30, audioDurationSec: 30 }),
    );
});

test.afterAll(async () => {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const events: unknown[] = [];
        Object.assign(window, { mseEvents: events });
        for (const type of [
            "pause",
            "play",
            "waiting",
            "stalled",
            "ended",
            "loadedmetadata",
            "emptied",
            "ratechange",
        ]) {
            document.addEventListener(
                type,
                (event) => {
                    const video = event.target;
                    if (!(video instanceof HTMLVideoElement)) return;
                    events.push({
                        type,
                        id: video.id,
                        time: video.currentTime,
                        rate: video.playbackRate,
                        paused: video.paused,
                        buffered: Array.from({ length: video.buffered.length }, (_, i) => [
                            video.buffered.start(i),
                            video.buffered.end(i),
                        ]),
                    });
                },
                true,
            );
        }
    });
    await presetLocalStorage(page);
    await gotoApp(page, "en");
});

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const diagnosis = await page.evaluate(() => ({
        events: (window as Window & { mseEvents?: unknown[] }).mseEvents,
        logs: window.__everydashcam.dumpLog(),
        videos: Array.from(document.querySelectorAll("video"), (video) => ({
            id: video.id,
            time: video.currentTime,
            rate: video.playbackRate,
            ready: video.readyState,
            paused: video.paused,
            buffered: Array.from({ length: video.buffered.length }, (_, i) => [
                video.buffered.start(i),
                video.buffered.end(i),
            ]),
        })),
    }));
    const path = testInfo.outputPath("mse-diagnosis.json");
    await writeFile(path, JSON.stringify(diagnosis, null, 2));
    await testInfo.attach("mse-diagnosis", { path, contentType: "application/json" });
});

test("preserves source reflection in MSE playback and re-encoded export", async ({ page }) => {
    test.setTimeout(120_000);
    await installExportCapture(page);
    const capture = (mirrored: boolean) =>
        page.locator("#player").evaluate(async (video: HTMLVideoElement, mirrored) => {
            video.pause();
            if (video.currentTime !== 0.2 || video.seeking) {
                await new Promise<void>((resolve) => {
                    video.addEventListener("seeked", () => resolve(), { once: true });
                    video.currentTime = 0.2;
                });
            }
            const canvas = document.createElement("canvas");
            canvas.width = 80;
            canvas.height = 45;
            const ctx = canvas.getContext("2d")!;
            if (mirrored) {
                ctx.translate(80, 0);
                ctx.scale(-1, 1);
            }
            ctx.drawImage(video, 0, 0, 80, 45);
            return [...ctx.getImageData(0, 0, 80, 45).data];
        }, mirrored);
    await loadTrip(page, join(fixtureDirectory, "plain"));
    await pausePlayback(page);
    const expected = await capture(true);
    const unflipped = await capture(false);
    const difference = (a: number[], b: number[]) =>
        a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
    expect(difference(expected, unflipped), "the fixture distinguishes a reflection").toBeGreaterThan(5);

    await gotoApp(page, "en");
    await loadTrip(page, join(fixtureDirectory, "mirrored"));
    await pausePlayback(page);
    expect(difference(expected, await capture(false)), "MSE preserves container reflection").toBeLessThan(3);
    await openExport(page);
    await page.locator('input[name="export-panel-quality"][value="medium"]').check();
    await page.locator("#export-panel-watermark").uncheck();
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });
    const done = await readTranscodeDoneFields(page);
    expect(done!.framesEncoded).toBeGreaterThan(0);
    expect(done!.framesDirect).toBe(0);
    const exported = await page.evaluate(async () => {
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
            await new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
                video.currentTime = 0.2;
            });
            const canvas = document.createElement("canvas");
            canvas.width = 80;
            canvas.height = 45;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(video, 0, 0, 80, 45);
            return [...ctx.getImageData(0, 0, 80, 45).data];
        } finally {
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
        }
    });
    expect(difference(expected, exported), "export bakes in the source reflection").toBeLessThan(8);
});

test("starts MSE playback when one GOP exceeds the ahead window", async ({ page }) => {
    await loadTrip(page, join(fixtureDirectory, "long-gop"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(4);
    // A trim inside the first GOP would evict its current decode dependencies.
    expect(await page.locator("#player").evaluate((video: HTMLVideoElement) => video.buffered.start(0))).toBe(0);
});

test("plays video past the end of a shorter audio track", async ({ page }) => {
    await loadTrip(page, join(fixtureDirectory, "short-audio"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(2);
});

test("retains an ordinary matched audio track in MSE playback", async ({ page }) => {
    await loadTrip(page, join(fixtureDirectory, "matched-audio"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.readyState))
        .toBeGreaterThanOrEqual(2);
    const audioTracks = await page.locator("#player").evaluate((video: HTMLVideoElement) => {
        const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
        const count = stream.getAudioTracks().length;
        for (const track of stream.getTracks()) track.stop();
        return count;
    });
    expect(audioTracks).toBe(1);
});

test("keeps video playing when MSE rejects the copied audio codec", async ({ page }) => {
    await page.evaluate(() => {
        const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
        MediaSource.isTypeSupported = (mime) => (mime.includes("mp4a.40.2") ? false : isTypeSupported(mime));
    });
    await loadTrip(page, join(fixtureDirectory, "matched-audio"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(0.5);
    const audioTracks = await page.locator("#player").evaluate((video: HTMLVideoElement) => {
        const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
        const count = stream.getAudioTracks().length;
        for (const track of stream.getTracks()) track.stop();
        return count;
    });
    expect(audioTracks).toBe(0);
    await expect(page.locator(".viewer")).not.toHaveClass(/playback-failed|codec-unsupported/);
    expect(
        await page.evaluate(() =>
            window.__everydashcam.dumpLog().filter((entry) => entry.msg.startsWith("backend fail")),
        ),
    ).toEqual([]);
});

test("plays MPEG-TS video with AAC sound before and after a seek", async ({ page }) => {
    await loadTrip(page, join(fixtureDirectory, "ts-audio"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(1);
    await page.keyboard.press("5");
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(16);
    const audioTracks = await page.locator("#player").evaluate((video: HTMLVideoElement) => {
        const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
        const count = stream.getAudioTracks().length;
        for (const track of stream.getTracks()) track.stop();
        return count;
    });
    expect(audioTracks).toBe(1);
    expect(
        await page.evaluate(() =>
            window.__everydashcam.dumpLog().filter((entry) => entry.msg.startsWith("backend fail")),
        ),
    ).toEqual([]);
});

test("keeps the MPEG-TS buffer inside the ahead window while playing", async ({ page }) => {
    await loadTrip(page, join(fixtureDirectory, "ts-audio"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(3);
    // The worker feeds a bounded window ahead of the playhead (BASE_BUFFER_AHEAD_SEC
    // plus the fragment that closes it). A buffer far beyond that means the feed
    // gate opened wide, which is how a clip ends up thrashing the SourceBuffer quota.
    const lead = await page.locator("#player").evaluate((video: HTMLVideoElement) => {
        const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
        return end - video.currentTime;
    });
    expect(lead).toBeLessThan(14);
    expect(
        await page.evaluate(() =>
            window.__everydashcam.dumpLog().filter((entry) => /quota exceeded|backend fail/.test(entry.msg)),
        ),
    ).toEqual([]);
});

test("warms the next MPEG-TS clip's worker before the clip boundary", async ({ page }) => {
    // Two consecutive clips of one trip (names 6 s apart, like the first clip's
    // length); distinct content so ingest does not fold them into one file.
    const clips = await Promise.all([
        createMseFixture({ format: "mpegts", gopCount: 6, audioDurationSec: 6 }),
        createMseFixture({ format: "mpegts", gopCount: 7, audioDurationSec: 7 }),
    ]);
    await page.locator("#file-input").setInputFiles([
        { name: "20260904_202849F.ts", mimeType: "video/mp2t", buffer: Buffer.from(clips[0]) },
        { name: "20260904_202855F.ts", mimeType: "video/mp2t", buffer: Buffer.from(clips[1]) },
    ]);
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().click();
    await expect
        .poll(() => page.evaluate(() => window.__everydashcam.state.active?.frame), { timeout: 20_000 })
        .toBe(1);
    const attaches = await page.evaluate(() =>
        window.__everydashcam
            .dumpLog()
            .filter((entry) => entry.msg === "attach: mse start")
            .map((entry) => ({ file: entry.ctx?.file, prewarmed: entry.ctx?.prewarmed })),
    );
    expect(attaches).toEqual([
        { file: "20260904_202849F.ts", prewarmed: false },
        { file: "20260904_202855F.ts", prewarmed: true },
    ]);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(1);
    expect(
        await page.evaluate(() =>
            window.__everydashcam.dumpLog().filter((entry) => entry.msg.startsWith("backend fail")),
        ),
    ).toEqual([]);
});

test("seeks back to the initial position after MSE trims it", async ({ page }) => {
    await loadTrip(page, join(fixtureDirectory, "seek-zero"));
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(0.1);
    // Reach the trim threshold at the normal rate; changing playback speed
    // during decoder startup exercises a separate browser transition.
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(8);
    await page.locator("#player").evaluate((video: HTMLVideoElement) => video.pause());
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.buffered.start(0)))
        .toBeGreaterThan(0);
    await page.keyboard.press("0");
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeLessThan(0.2);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.readyState))
        .toBeGreaterThanOrEqual(2);
});

test("retries a quota-blocked append after playback frees a complete GOP", async ({ page }) => {
    await installQuotaFault(page);
    await loadTrip(page, join(fixtureDirectory, "seek-zero"));
    await expect.poll(async () => (await readQuotaFault(page)).retries).toBe(1);
    expect(await page.locator("#player").evaluate((video: HTMLVideoElement) => video.buffered.length)).toBe(1);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(8);
    const fault = await readQuotaFault(page);
    expect(fault.injected).toBe(true);
    expect(fault.bufferedEnd).toBeGreaterThanOrEqual(6);
    expect(fault.futureRemovals).toBe(0);
    expect(fault.retries).toBe(1);
});

test("discards a quota-blocked append when seeking to a new feed cycle", async ({ page }) => {
    await installQuotaFault(page);
    await loadTrip(page, join(fixtureDirectory, "seek-zero"));
    await page.locator("#player").evaluate((video: HTMLVideoElement) => video.pause());
    await expect.poll(async () => (await readQuotaFault(page)).injected).toBe(true);
    expect((await readQuotaFault(page)).retries).toBe(0);
    await page.keyboard.press("5");
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(19);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.readyState))
        .toBeGreaterThanOrEqual(2);
    await page.locator("#player").evaluate((video: HTMLVideoElement) => video.play());
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(21);
    expect((await readQuotaFault(page)).retries).toBe(0);
});

test("frees a complete video GOP when the quota fault lands on an audio-only fragment", async ({ page }) => {
    await installQuotaFault(page, 20);
    await loadTrip(page, join(fixtureDirectory, "audio-leading"));
    // The third GOP is fed once the playhead is within the ahead window of the
    // second GOP's end; the audio-only fragments ahead of its keyframe meet the
    // fault at about 13 s of playback, and the recovery must still trim at a
    // video keyframe.
    await expect.poll(async () => (await readQuotaFault(page)).injected, { timeout: 25_000 }).toBe(true);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(6);
    await expect.poll(async () => (await readQuotaFault(page)).retries).toBe(1);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(12);
    const fault = await readQuotaFault(page);
    expect(fault.bufferedEnd).toBeGreaterThanOrEqual(20);
    expect(fault.futureRemovals).toBe(0);
    expect(fault.retries).toBe(1);
});

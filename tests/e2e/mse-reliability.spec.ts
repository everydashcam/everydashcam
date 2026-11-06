import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import {
    DESKTOP,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    mockDirectoryPicker,
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

/** Opens two front+rear pairs (6 s and 7 s) whose rear clips use
 *  `rearGopDurationSec` instead of 1 s GOPs and so outlast their fronts: the
 *  trip plays a rear-only tail after each pair. MPEG-TS plays through MSE,
 *  MP4 natively. Playback runs in the first pair. */
async function openPairedTailTrip(
    page: Page,
    rearGopDurationSec: number,
    format: "mpegts" | "mp4" = "mpegts",
): Promise<void> {
    const clips = await Promise.all([
        createMseFixture({ format, gopCount: 6 }),
        createMseFixture({ format, gopCount: 6, gopDurationSec: rearGopDurationSec }),
        createMseFixture({ format, gopCount: 7 }),
        createMseFixture({ format, gopCount: 7, gopDurationSec: rearGopDurationSec }),
    ]);
    const extension = format === "mpegts" ? "ts" : "MP4";
    const mimeType = format === "mpegts" ? "video/mp2t" : "video/mp4";
    await page.locator("#file-input").setInputFiles(
        ["20260904_202849F", "20260904_202849R", "20260904_202855F", "20260904_202855R"].map((name, index) => ({
            name: `${name}.${extension}`,
            mimeType,
            buffer: Buffer.from(clips[index]!),
        })),
    );
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().click();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { state } = window.__everydashcam;
                const trip = state.active ? state.trips[state.active.trip] : undefined;
                return trip?.frames.map((frame) => Object.keys(frame.channels).sort().join("+"));
            }),
        )
        .toEqual(["front+rear", "rear", "front+rear", "rear"]);
}

test("plays a paired MPEG-TS tail on the running channel and keeps the next pair warm", async ({ page }) => {
    // The rear element already plays the rear-only tail; a new attachment
    // there stalls the picture and drops the warm next rear clip. The front
    // tile holds its last frame meanwhile instead of blinking out, also
    // through a layout change. The tail is 0.3 s, a real camera's order.
    await openPairedTailTrip(page, 1.05);
    // Record, every display frame of the rear-only tail, whether the front
    // tile or the layout control disappeared. The first tail frame switches
    // the layout.
    const tail = page.evaluate(
        () =>
            new Promise<{ samples: number; frontHidden: number; viewModeHidden: number }>((resolve, reject) => {
                const { state, dom } = window.__everydashcam;
                const timeout = setTimeout(() => reject(new Error("second pair did not start")), 20_000);
                const result = { samples: 0, frontHidden: 0, viewModeHidden: 0 };
                const tick = (): void => {
                    const frame = state.active?.frame ?? 0;
                    if (frame === 1) {
                        if (result.samples === 0) dom.viewModeBtn.click();
                        result.samples++;
                        if (dom.videoTileFront.hidden) result.frontHidden++;
                        if (dom.viewModeBtn.hidden) result.viewModeHidden++;
                    }
                    if (frame >= 2) {
                        clearTimeout(timeout);
                        resolve(result);
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }),
    );
    expect((await tail).samples, "display frames in the tail").toBeGreaterThan(3);
    expect(await tail, "front tile and layout control through the tail").toMatchObject({
        frontHidden: 0,
        viewModeHidden: 0,
    });
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(0.5);
    const attaches = await page.evaluate(() =>
        window.__everydashcam
            .dumpLog()
            .filter((entry) => entry.msg === "attach: mse start")
            .map((entry) => ({ file: entry.ctx?.file, prewarmed: entry.ctx?.prewarmed })),
    );
    expect(attaches).toEqual([
        { file: "20260904_202849F.ts", prewarmed: false },
        { file: "20260904_202849R.ts", prewarmed: false },
        { file: "20260904_202855F.ts", prewarmed: true },
        { file: "20260904_202855R.ts", prewarmed: true },
    ]);
});

test("moves past a paired tail that its camera already played as a slave", async ({ page }) => {
    // A slave may run up to the drift tolerance ahead of its master. With a
    // 12 ms tail the rear then ends before the front crosses into the tail
    // it leads; seeking it back there and resuming restarted the whole rear
    // clip inside the tail.
    await openPairedTailTrip(page, 1.002, "mp4");
    const tailMs = await page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const { state, dom } = window.__everydashcam;
                const trip = state.trips[state.active!.trip]!;
                const tailStartSec = trip.timeline.segments[1]!.contentStart;
                const timeout = setTimeout(() => reject(new Error("second pair did not start")), 20_000);
                let hasShifted = false;
                let tailStartedAt = 0;
                const tick = (): void => {
                    const frame = state.active?.frame ?? 0;
                    if (!hasShifted && frame === 0 && dom.player.currentTime >= tailStartSec - 1) {
                        hasShifted = true;
                        const rear = [
                            ...dom.videoTileRear.querySelectorAll<HTMLVideoElement>('video[id^="player-rear"]'),
                        ].find((video) => !video.classList.contains("preload-slot"))!;
                        rear.currentTime = dom.player.currentTime + 0.1;
                    }
                    if (frame === 1 && !tailStartedAt) tailStartedAt = performance.now();
                    if (frame >= 2) {
                        clearTimeout(timeout);
                        resolve(tailStartedAt ? performance.now() - tailStartedAt : 0);
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }),
    );
    expect(tailMs, "time spent in the 12 ms tail").toBeLessThan(1000);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.dom.player.currentTime)).toBeGreaterThan(0.5);
});

test("drops the shorter camera when a seek from the middle of its pair lands in the tail", async ({ page }) => {
    // The front element is mid-clip, not at its end: holding it would show a
    // frame from another moment that keeps playing, out of reach of pause.
    // A 1.2 s tail leaves room for the seek to land well inside it.
    await openPairedTailTrip(page, 1.2);
    const tail = await page.evaluate(
        () =>
            new Promise<{ samples: number; frontVisible: number; frontPlaying: number }>((resolve, reject) => {
                const { state, dom } = window.__everydashcam;
                const trip = state.trips[state.active!.trip]!;
                const segment = trip.timeline.segments[1]!;
                // The arrow key seeks 5 s ahead; from here it lands mid-tail.
                const seekFromSec = segment.contentStart + segment.durationSec / 2 - 5;
                const timeout = setTimeout(() => reject(new Error("seek did not reach the tail")), 20_000);
                const result = { samples: 0, frontVisible: 0, frontPlaying: 0 };
                let hasSeeked = false;
                const tick = (): void => {
                    const frame = state.active?.frame ?? 0;
                    if (!hasSeeked && frame === 0 && dom.player.currentTime >= seekFromSec) {
                        hasSeeked = true;
                        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" }));
                    }
                    if (hasSeeked && frame === 1) {
                        result.samples++;
                        if (!dom.videoTileFront.hidden) result.frontVisible++;
                        const frontVideos = [...dom.videoTileFront.querySelectorAll("video")];
                        if (frontVideos.some((video) => !video.paused)) result.frontPlaying++;
                    }
                    if (frame >= 2) {
                        clearTimeout(timeout);
                        resolve(result);
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }),
    );
    expect(tail.samples, "display frames in the tail").toBeGreaterThan(0);
    expect(tail, "front camera through the tail").toMatchObject({ frontVisible: 0, frontPlaying: 0 });
});

test("retargets a prewarmed worker when the user seeks into the next clip", async ({ page }) => {
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
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(1);
    // 70 % of the 13 s trip lands about 3 s into the second clip: the backend
    // warmed for position 0 must start its feed there instead.
    await page.keyboard.press("7");
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.active?.frame)).toBe(1);
    const attach = await page.evaluate(() =>
        window.__everydashcam
            .dumpLog()
            .filter((entry) => entry.msg === "attach: mse start" && entry.ctx?.file === "20260904_202855F.ts")
            .map((entry) => ({ prewarmed: entry.ctx?.prewarmed, startSec: entry.ctx?.startSec as number })),
    );
    expect(attach).toHaveLength(1);
    expect(attach[0]!.prewarmed).toBe(true);
    expect(attach[0]!.startSec).toBeGreaterThan(2);
    expect(attach[0]!.startSec).toBeLessThan(4.5);
    await expect
        .poll(() => page.locator("#player").evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(attach[0]!.startSec);
    expect(
        await page.locator("#player").evaluate((video: HTMLVideoElement) => video.buffered.start(0)),
    ).toBeGreaterThan(1.5);
});

/** A GPX sidecar for one clip of a route that drives east at 15 m/s and
 *  turns north `turnSec` after the route start. */
function routeGpx(routeStartUnixSec: number, fromSec: number, toSec: number, turnSec: number): string {
    const metersPerDegreeLat = 110_540;
    const metersPerDegreeLon = 111_320 * Math.cos((50 * Math.PI) / 180);
    const points: string[] = [];
    for (let second = fromSec; second <= toSec; second++) {
        const eastMeters = 15 * Math.min(second, turnSec);
        const northMeters = 15 * Math.max(0, second - turnSec);
        const lat = 50 + northMeters / metersPerDegreeLat;
        const lon = 10 + eastMeters / metersPerDegreeLon;
        const time = new Date((routeStartUnixSec + second) * 1000).toISOString().replace(".000", "");
        points.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><time>${time}</time></trkpt>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
${points.join("\n")}
</trkseg></trk></gpx>
`;
}

/** Opens two consecutive MPEG-TS clips (6 s and 7 s) with GPX sidecars on
 *  the large map in heading-up follow mode, playing in the first clip. The
 *  route starts at 50 N 10 E, drives east and turns north 2 s into the second
 *  clip. */
async function openTwoClipRoute(page: Page): Promise<void> {
    await page.setViewportSize(DESKTOP);
    const clips = await Promise.all([
        createMseFixture({ format: "mpegts", gopCount: 6 }),
        createMseFixture({ format: "mpegts", gopCount: 7 }),
    ]);
    const routeStart = Date.UTC(2026, 8, 4, 20, 28, 49) / 1000;
    await page.locator("#file-input").setInputFiles([
        { name: "20260904_202849F.ts", mimeType: "video/mp2t", buffer: Buffer.from(clips[0]) },
        {
            name: "20260904_202849F.gpx",
            mimeType: "application/gpx+xml",
            buffer: Buffer.from(routeGpx(routeStart, 0, 6, 8)),
        },
        { name: "20260904_202855F.ts", mimeType: "video/mp2t", buffer: Buffer.from(clips[1]) },
        {
            name: "20260904_202855F.gpx",
            mimeType: "application/gpx+xml",
            buffer: Buffer.from(routeGpx(routeStart, 6, 13, 8)),
        },
    ]);
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().click();
    await page.locator("#player-view-menu").click();
    await page.locator('[data-map-mode="large"]').first().click();
    await page.keyboard.press("Escape");
    await page.locator('.map-follow-seg[data-follow-mode="rotate"]').click();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { state, dom } = window.__everydashcam;
                return state.mapExpanded && state.followMode === "rotate" && dom.player.currentTime > 1;
            }),
        )
        .toBe(true);
}

test.describe("map position across MSE clips", () => {
    // The clip names carry local time; UTC makes them match the GPX timestamps.
    test.use({ timezoneId: "UTC" });

    test("keeps the heading-up camera on the car when the next MPEG-TS clip starts", async ({ page }) => {
        // The camera must stay on the eastbound car at the boundary, not aim
        // at the northbound end of the second clip, where the ended first
        // clip's time points.
        await openTwoClipRoute(page);
        // Sample every display frame from just before the boundary until the
        // second clip has played for a second.
        const boundary = await page.evaluate(
            () =>
                new Promise<{ maxDistanceMeters: number; minBearingDeg: number; samples: number }>(
                    (resolve, reject) => {
                        const { state, dom } = window.__everydashcam;
                        const timeout = setTimeout(() => reject(new Error("second clip did not play")), 20_000);
                        let maxDistanceMeters = 0;
                        let minBearingDeg = 360;
                        let samples = 0;
                        const tick = (): void => {
                            const map = state.map;
                            const marker = state.marker;
                            if (state.active?.frame === 1 && map && marker) {
                                const center = map.getCenter();
                                const car = marker.getLngLat();
                                const northMeters = (center.lat - car.lat) * 110_540;
                                const eastMeters =
                                    (center.lng - car.lng) * 111_320 * Math.cos((car.lat * Math.PI) / 180);
                                maxDistanceMeters = Math.max(maxDistanceMeters, Math.hypot(northMeters, eastMeters));
                                minBearingDeg = Math.min(minBearingDeg, (map.getBearing() + 360) % 360);
                                samples++;
                                if (dom.player.currentTime > 1) {
                                    clearTimeout(timeout);
                                    resolve({ maxDistanceMeters, minBearingDeg, samples });
                                    return;
                                }
                            }
                            requestAnimationFrame(tick);
                        };
                        requestAnimationFrame(tick);
                    },
                ),
        );
        expect(boundary.samples, "frames sampled in the second clip").toBeGreaterThan(5);
        // A camera aimed at the second clip's end is about 70 m away and faces north.
        expect(boundary.maxDistanceMeters, "camera distance from the car").toBeLessThan(30);
        expect(boundary.minBearingDeg, "camera bearing while the car heads east").toBeGreaterThan(60);
    });

    test("holds the map marker on a seek target while the previous MPEG-TS clip loads", async ({ page }) => {
        await openTwoClipRoute(page);
        await expect
            .poll(() => page.evaluate(() => window.__everydashcam.state.active?.frame), { timeout: 20_000 })
            .toBe(1);
        // Digit 3 seeks to 30 % of the 13 s trip: 3.9 s into the first clip,
        // about 58 m east of the route start. The first clip's feed restarts
        // from that offset while its element sits at 0.
        const markerPath = page.evaluate(
            () =>
                new Promise<{ minStartDistanceMeters: number; samples: number }>((resolve, reject) => {
                    const { state, dom } = window.__everydashcam;
                    const timeout = setTimeout(() => reject(new Error("seek did not land")), 20_000);
                    let minStartDistanceMeters = Number.POSITIVE_INFINITY;
                    let samples = 0;
                    const tick = (): void => {
                        const marker = state.marker;
                        if (state.active?.frame === 0 && marker) {
                            const car = marker.getLngLat();
                            const northMeters = (car.lat - 50) * 110_540;
                            const eastMeters = (car.lng - 10) * 111_320 * Math.cos((50 * Math.PI) / 180);
                            minStartDistanceMeters = Math.min(
                                minStartDistanceMeters,
                                Math.hypot(northMeters, eastMeters),
                            );
                            samples++;
                            if (dom.player.currentTime > 4.4) {
                                clearTimeout(timeout);
                                resolve({ minStartDistanceMeters, samples });
                                return;
                            }
                        }
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                }),
        );
        await page.keyboard.press("Digit3");
        const path = await markerPath;
        expect(path.samples, "frames sampled after the seek").toBeGreaterThan(5);
        // The element's own time would put the marker at the clip start first.
        expect(path.minStartDistanceMeters, "marker distance from the clip start").toBeGreaterThan(40);
    });
});

test("seeks past a newly added clip's provisional duration after reopening its folder", async ({ page }) => {
    const directory = join(fixtureDirectory, "prewarm-metadata");
    await mkdir(directory);
    const clips = await Promise.all([
        createMseFixture({ format: "mpegts", gopCount: 30, audioDurationSec: 30 }),
        createMseFixture({ format: "mpegts", gopCount: 60, audioDurationSec: 60 }),
    ]);
    await writeFile(join(directory, "20260904_202800F.ts"), clips[0]);
    await mockDirectoryPicker(page, [{ label: "MOCKCARD", dir: directory }]);
    await page.reload();
    await page.locator("#landing-cta").click();
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().click();
    await pausePlayback(page);

    // Reopen the same directory handle: a separate file-input batch would have
    // its own source identity and would not extend the active trip. The new
    // clip is initially estimated at 30 s from the filename spacing, then its
    // metadata replaces that estimate with 60 s while the first clip is open.
    await writeFile(join(directory, "20260904_202830F.ts"), clips[1]);
    await page.evaluate(async () => {
        const root = (window as unknown as { __e2eDirectoryPickerRoots: FileSystemDirectoryHandle[] })
            .__e2eDirectoryPickerRoots[0]!;
        const handle = await root.getFileHandle("20260904_202830F.ts", { create: true });
        const writable = await handle.createWritable();
        const response = await fetch("https://everydashcam-fsa.test/__fsa/0/20260904_202830F.ts");
        await writable.write(await response.arrayBuffer());
        await writable.close();
    });
    await page.locator("#sidebar-cta").click();
    await expect(page.locator("#player-total")).toHaveText("1:30");
    await expect(trips).toHaveCount(1);

    // 80 % of the 90 s trip is 42 s into the added clip. A backend retaining
    // its provisional duration clamps this seek to 30 s, outside its buffer.
    await page.keyboard.press("8");
    const player = page.locator("#player");
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(42, 0);
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    const seekTime = await player.evaluate((video: HTMLVideoElement) => video.currentTime);
    await page.locator("#player-play").click();
    await expect
        .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
        .toBeGreaterThan(seekTime + 0.5);
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

// Export EXECUTION (not just the panel): drives the Save flow end to end with
// window.showSaveFilePicker stubbed to an in-memory file, then inspects the
// bytes the pipeline actually produced. Two real paths:
//   - stream-copy (single channel, no transforms) + GPMF meta-track injection
//   - re-encode / compositing (multichannel split-screen via WebCodecs)
//
// Container markers cover both paths; native playback checks the trimmed
// stream-copy timeline against source frames before and after the file join.

import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";

import {
    DESKTOP,
    type ExportSinkFailure,
    SAMPLE_70MAI,
    canEncodeHighProfileH264,
    expect,
    gotoApp,
    installExportCapture,
    installInMemoryExportCapture,
    loadTrip,
    openExport,
    presetLocalStorage,
    readExportResult,
    readInMemoryDownload,
    readTranscodeDoneFields,
    test,
} from "./_fixtures.js";

test.describe("export run", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await installExportCapture(page); // before gotoApp - captured at bundle load
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page);
    });

    test("stream-copy single channel writes a valid MP4 with a GPMF track", { tag: "@golden-export" }, async ({
        page,
    }) => {
        // Reduce to one channel -> canStreamCopy() is true (no re-encode). GPMF is
        // kept by default, so the
        // post-process meta-track injection must run and land a 'gpmd' handler.
        const includes = page.locator(".top-panel__channel-include");
        await expect(includes).toHaveCount(3);
        await includes.nth(2).click();
        await includes.nth(1).click();
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);

        // Native path streams to disk at any size -> the in-memory warning stays
        // hidden (the other half of the no-native assertion below).
        await expect(page.locator("#export-panel-fallback-warn")).toBeHidden();

        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });
        await expect(page.locator("#export-panel-done-summary")).toBeFocused();

        const r = await readExportResult(page);
        expect(r, "export must have written bytes through the stubbed handle").not.toBeNull();
        expect(r!.len, "produced MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp, "MP4 must have an ftyp box").toBe(true);
        expect(r!.moov, "MP4 must have a moov box").toBe(true);
        expect(r!.mdat, "MP4 must have media data").toBe(true);
        expect(r!.gpmd, "GPMF telemetry track (gpmd handler) must be injected").toBe(true);
        expect(r!.soun, "audio must be copied into the stream-copy export").toBe(true);

        await page.keyboard.press("Tab");
        await expect(page.locator("#export-panel-done button")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#export-panel")).toBeHidden();
        await expect(page.locator("#player-export")).toBeFocused();
    });

    test("stream-copy hides the preceding GOP and seeks across a trimmed file join", async ({ page }) => {
        const includes = page.locator(".top-panel__channel-include");
        await includes.nth(2).click();
        await includes.nth(1).click();
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);

        // Both real H.264 streams contain B-frames and begin with their only keyframe.
        // The selected range crosses their join at 2 s and starts inside the first GOP.
        const firstPath = resolve(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4");
        const secondPath = resolve(SAMPLE_70MAI, "Normal/Front/NO20260101-120002-000002F.MP4");
        for (const [edge, time] of [
            ["start", "1"],
            ["end", "3"],
        ] as const) {
            const input = page.locator(`.export-trim-bar__input[data-range-edge="${edge}"]`);
            await input.fill(time);
            await input.press("Enter");
        }
        await expect(page.locator(".timeline-range__tab--start")).toHaveAttribute("aria-valuenow", "1");
        await expect(page.locator(".timeline-range__tab--end")).toHaveAttribute("aria-valuenow", "3");
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });

        const container = await readExportResult(page);
        expect(container?.gpmd, "trimmed export retains its GPS track").toBe(true);
        expect(container?.soun, "trimmed export retains audio").toBe(true);
        const bytes = await page.evaluate(() => {
            const handle = (window as unknown as { __lastExportHandle?: { _buf: Uint8Array } }).__lastExportHandle;
            if (!handle) throw new Error("export handle missing");
            return Array.from(handle._buf);
        });
        const exported = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: [MP4] });
        const original = new Input({ source: new BufferSource(readFileSync(firstPath)), formats: [MP4] });
        try {
            const outputVideo = (await exported.getPrimaryVideoTrack())!;
            const sourceVideo = (await original.getPrimaryVideoTrack())!;
            const outputHead = (await new EncodedPacketSink(outputVideo).getFirstPacket())!;
            const sourceSink = new EncodedPacketSink(sourceVideo);
            const sourceHead = (await sourceSink.getKeyPacket(1, { verifyKeyPackets: true }))!;
            expect(sourceHead.timestamp, "trim point falls after the preceding keyframe").toBe(0);
            expect(outputHead.timestamp, "preceding GOP is retained only as decoder preroll").toBeCloseTo(-1, 5);
            expect(outputHead.data, "video is copied without re-encoding").toEqual(sourceHead.data);
            const duration = await outputVideo.computeDuration();
            expect(duration).toBeGreaterThanOrEqual(2);
            expect(duration, "duration excludes the hidden second, allowing B-frame postroll").toBeLessThan(2.3);
        } finally {
            exported.dispose();
            original.dispose();
        }

        const playback = await inspectTrimmedPlayback(page, [
            Array.from(readFileSync(firstPath)),
            Array.from(readFileSync(secondPath)),
        ]);
        expect(playback.duration).toBeGreaterThanOrEqual(2);
        expect(playback.duration, "native playback respects the edit list").toBeLessThan(2.3);
        expect(playback.headDifference, "first visible frames match the selected source time").toBeLessThan(0.5);
        expect(playback.joinDifference, "seeking beyond the file join preserves the source timeline").toBeLessThan(0.5);
        expect(playback.playedUntil, "native playback advances after seeking").toBeGreaterThan(1.35);
    });

    test("manual bitrate re-encodes Original and clearing it copies the source packets", async ({
        page,
        browserName,
    }) => {
        test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
        test.skip(
            !(await canEncodeHighProfileH264(page)),
            "WebCodecs High-profile H.264 encode not available on this platform",
        );
        test.setTimeout(120_000);

        const includes = page.locator(".top-panel__channel-include");
        await includes.nth(2).click();
        await includes.nth(1).click();
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);
        await expect(page.locator("#export-panel-output")).toHaveValue("source");
        await expect(page.locator('input[name="export-panel-quality"][value="original"]')).toBeChecked();
        await page.locator("#export-panel-watermark").uncheck();
        await page.locator(".export-panel__manual-bitrate > summary").click();
        const manual = page.locator("#export-panel-bitrate");
        await manual.fill("2");
        await manual.blur();
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });

        const done = await readTranscodeDoneFields(page);
        expect(done?.framesEncoded, "the manual bitrate must run the encoder").toBeGreaterThan(0);
        expect(
            await page.evaluate(
                () =>
                    window.__everydashcam
                        .dumpLog()
                        .reverse()
                        .find((record) => record.msg === "export settings")?.ctx,
            ),
        ).toMatchObject({ mode: "single", quality: "original", manualBitrateMbps: 2, encodeBitrate: 2_000_000 });
        const encoded = await readExportResult(page);
        expect(encoded?.mdat, "the manual export must contain encoded media").toBe(true);

        await page.locator("#export-panel-done button").click();
        await openExport(page);
        await manual.fill("");
        await manual.blur();
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });

        const copied = await page.evaluate(() => {
            const handle = (window as unknown as { __lastExportHandle: { _buf: Uint8Array } }).__lastExportHandle;
            return {
                bytes: Array.from(handle._buf),
                settings: window.__everydashcam
                    .dumpLog()
                    .reverse()
                    .find((record) => record.msg === "export settings")?.ctx,
            };
        });
        expect(copied.settings).toMatchObject({ mode: "stream-copy", manualBitrateMbps: null, encodeBitrate: null });
        const exported = new Input({ source: new BufferSource(new Uint8Array(copied.bytes)), formats: [MP4] });
        const source = new Input({
            source: new BufferSource(readFileSync(resolve(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4"))),
            formats: [MP4],
        });
        try {
            const outputHead = await new EncodedPacketSink((await exported.getPrimaryVideoTrack())!).getFirstPacket();
            const sourceHead = await new EncodedPacketSink((await source.getPrimaryVideoTrack())!).getFirstPacket();
            expect(outputHead, "the restored copy contains video packets").not.toBeNull();
            expect(sourceHead, "the source contains video packets").not.toBeNull();
            expect(outputHead?.data, "clearing the override restores untouched source packets").toEqual(
                sourceHead?.data,
            );
        } finally {
            exported.dispose();
            source.dispose();
        }
    });

    test("re-encode split-screen writes a valid MP4 (compositing pipeline)", { tag: "@golden-export" }, async ({
        page,
        browserName,
    }) => {
        // Default multichannel keeps all 3 channels -> split-screen -> canStreamCopy
        // is false -> the decode/composite/re-encode WebCodecs pipeline runs. This
        // is the only coverage of the actual compositing path. Skip (not fail)
        // where High-profile H.264 encode is unavailable - the stream-copy case
        // above still exercises the mux path everywhere.
        // Firefox: H.264 encode is broken (Bugzilla 1918769) and the probe can't
        // see it (isConfigSupported lies), so skip Gecko explicitly.
        test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
        test.skip(
            !(await canEncodeHighProfileH264(page)),
            "WebCodecs High-profile H.264 encode not available on this platform",
        );

        test.setTimeout(120_000);
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(3);

        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });

        const r = await readExportResult(page);
        expect(r, "re-encode must have written bytes").not.toBeNull();
        expect(r!.len, "re-encoded MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp).toBe(true);
        expect(r!.moov).toBe(true);
        expect(r!.mdat).toBe(true);
        // GPMF on the re-encode path: the worker relays its captured moov and the
        // track is written into the still-open output by the before-commit hook
        // (transcode-shim.ts), a different wiring from the stream-copy tests.
        expect(r!.gpmd, "GPMF track must inject on the re-encode path too").toBe(true);
        // Audio survives the re-encode: the 70mai source is AAC, so the pipeline
        // stream-copies its packets through the compositing export with NO audio
        // encoder (the codec-stripped-Chromium fix). A regression here = silent clip.
        expect(r!.soun, "audio (AAC passthrough) must survive the re-encode export").toBe(true);
        await expectEncoderDiagnostics(page, "split transcode done");
    });

    test("re-encode single channel takes the composite-free path", async ({ page, browserName }) => {
        // One channel, source dimensions, no overlays, no watermark: nothing is
        // painted over the video, so the pipeline hands decoded frames straight to
        // the encoder instead of routing them through the composition canvas. The
        // only coverage of that branch - a source whose frames the encoder rejects
        // (or silently mis-renders) would otherwise ship a broken file.
        test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
        test.skip(
            !(await canEncodeHighProfileH264(page)),
            "WebCodecs High-profile H.264 encode not available on this platform",
        );
        test.setTimeout(120_000);

        const includes = page.locator(".top-panel__channel-include");
        await includes.nth(2).click();
        await includes.nth(1).click();
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);

        // Below the top tier -> re-encode (the top tier would stream-copy instead).
        await page.locator('input[name="export-panel-quality"][value="medium"]').check();
        await page.locator("#export-panel-watermark").uncheck();

        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });

        const r = await readExportResult(page);
        expect(r, "re-encode must have written bytes").not.toBeNull();
        expect(r!.len, "re-encoded MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp).toBe(true);
        expect(r!.moov).toBe(true);
        expect(r!.mdat).toBe(true);
        expect(r!.soun, "audio must survive the composite-free re-encode").toBe(true);

        // The done-line reports how many frames skipped the canvas. Without this
        // the test would still pass with the fast path silently never engaging.
        const done = await readTranscodeDoneFields(page);
        expect(done, "the transcode worker must have logged its done line").not.toBeNull();
        expect(done!.framesEncoded, "frames must have been encoded").toBeGreaterThan(0);
        expect(done!.framesDirect, "every frame should have bypassed the canvas").toBe(done!.framesEncoded);
        await expectEncoderDiagnostics(page, "transcode done");
    });
});

async function expectEncoderDiagnostics(page: Page, doneMessage: string): Promise<void> {
    const { bytes, config, summary } = await page.evaluate((doneMessage) => {
        const logs = window.__everydashcam.dumpLog().reverse();
        const handle = (window as unknown as { __lastExportHandle: { _buf: Uint8Array } }).__lastExportHandle;
        return {
            bytes: Array.from(handle._buf),
            config: logs.find((record) => record.msg === "video encoder config requested")?.ctx,
            summary: logs.find((record) => record.msg === doneMessage)?.ctx,
        };
    }, doneMessage);
    expect(config).toMatchObject({
        bitrateMode: "variable",
        latencyMode: "quality",
        hardwareAcceleration: "no-preference",
    });
    expect(Math.round(Number(config?.bitrate) / 1000)).toBe(summary?.bitrateKbps);
    const input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: [MP4] });
    try {
        const video = (await input.getPrimaryVideoTrack())!;
        let videoBytes = 0;
        let packets = 0;
        let keyPackets = 0;
        let first = Infinity;
        let last = -Infinity;
        for await (const packet of new EncodedPacketSink(video).packets()) {
            videoBytes += packet.byteLength;
            packets++;
            if (packet.type === "key") keyPackets++;
            first = Math.min(first, packet.timestamp);
            last = Math.max(last, packet.timestamp + packet.duration);
        }
        expect(summary).toMatchObject({ videoPackets: packets, videoKeyPackets: keyPackets, videoBytes });
        expect(summary?.videoPackets).toBe(summary?.framesEncoded);
        expect(summary?.encodedCodec).toMatch(/^avc1\./);
        expect(summary?.videoBytes).toBeLessThan(bytes.length);
        expect(Number(summary?.videoDurationSec)).toBeCloseTo(last - first, 5);
        expect(summary?.videoBitrateKbps).toBe(Math.round((videoBytes * 8) / (last - first) / 1000));
    } finally {
        input.dispose();
    }
    await page.locator("#feedback-btn").click();
    await page.locator("#feedback-recordings-skip").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#feedback-primary").click();
    const report = readFileSync(await (await downloadPromise).path(), "utf8");
    expect(report).toContain("video encoder config requested");
    expect(report).toContain(`videoBytes=${summary?.videoBytes}`);
    expect(report).toContain("export settings");
}

async function inspectTrimmedPlayback(page: Page, sources: number[][]) {
    return page.evaluate(async (sources) => {
        const handle = (window as unknown as { __lastExportHandle?: { _buf: Uint8Array } }).__lastExportHandle;
        if (!handle) throw new Error("export handle missing");
        const url = URL.createObjectURL(new Blob([handle._buf.slice()], { type: "video/mp4" }));
        const sourceUrls = sources.map((bytes) =>
            URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/mp4" })),
        );
        const videos: HTMLVideoElement[] = [];
        const waitFor = (video: HTMLVideoElement, event: string) =>
            new Promise<void>((resolve, reject) => {
                const clear = () => {
                    video.removeEventListener(event, done);
                    video.removeEventListener("error", fail);
                };
                const done = () => {
                    clear();
                    resolve();
                };
                const fail = () => {
                    clear();
                    reject(new Error(video.error?.message || "native video failed"));
                };
                video.addEventListener(event, done);
                video.addEventListener("error", fail);
            });
        const open = async (src: string) => {
            const video = document.createElement("video");
            videos.push(video);
            video.muted = true;
            video.preload = "auto";
            const loaded = waitFor(video, "loadeddata");
            video.src = src;
            await loaded;
            return video;
        };
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 54;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("canvas context unavailable");
        const pixelsAt = async (video: HTMLVideoElement, seconds: number) => {
            const sought = waitFor(video, "seeked");
            video.currentTime = seconds;
            await sought;
            if (Math.abs(video.currentTime - seconds) > 1e-5) throw new Error("native video did not reach seek target");
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
            a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
        try {
            const output = await open(url);
            const first = await open(sourceUrls[0]!);
            const second = await open(sourceUrls[1]!);
            const headDifference = difference(await pixelsAt(output, 0.05), await pixelsAt(first, 1.05));
            const joinDifference = difference(await pixelsAt(output, 1.25), await pixelsAt(second, 0.25));
            await output.play();
            while (output.currentTime <= 1.35) await waitFor(output, "timeupdate");
            output.pause();
            return { duration: output.duration, headDifference, joinDifference, playedUntil: output.currentTime };
        } finally {
            for (const video of videos) {
                video.pause();
                video.removeAttribute("src");
                video.load();
            }
            URL.revokeObjectURL(url);
            for (const sourceUrl of sourceUrls) URL.revokeObjectURL(sourceUrl);
        }
    }, sources);
}

// The destination dying mid-write. A sink failure is the one class of export
// failure the user can act on, and it reaches the error mapping only if its
// DOMException name survives - on the re-encode path that means surviving the
// worker port, which flattens errors to text. These two tests are the gate on
// that: a generic "something went wrong" here means the class was lost again.
test.describe("export run (the destination goes away)", () => {
    // The failure is injected on purpose, and the flow logs the raw cause to the
    // ring buffer (which mirrors to console.error) exactly as designed.
    // Firefox renders DOMException arguments as opaque handles. The stream-copy
    // case also verifies the actual logged exception, independently of that text.
    test.use({
        tolerateConsole: [/the destination is gone|^\[export-flow\] export failed JSHandle@object$/],
    });

    const setup = async (page: Page, failure: ExportSinkFailure): Promise<void> => {
        await presetLocalStorage(page);
        await installExportCapture(page, failure);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page);
        // One channel: stream-copy eligible, and the cheapest re-encode too.
        const includes = page.locator(".top-panel__channel-include");
        await includes.nth(2).click();
        await includes.nth(1).click();
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);
    };

    test("stream-copy: names the real cause and offers a way to report it", async ({ page }) => {
        await setup(page, { afterBytes: 0, errorName: "NotFoundError" });

        const loggedFailure = page.waitForEvent("console", {
            predicate: (message) =>
                message.type() === "error" && message.text().startsWith("[export-flow] export failed "),
        });
        await page.locator("#export-panel-save-btn").click();

        const status = page.locator(".export-panel__error-status");
        await expect(status).toBeVisible({ timeout: 60_000 });
        await expect(status).toBeFocused();
        await expect(status, "a lost destination must not read as the generic failure").toContainText(
            "the file being written is gone",
        );
        const loggedCause = (await loggedFailure).args()[1]!;
        expect(
            await loggedCause.evaluate((cause: unknown) => {
                if (!(cause instanceof Error) && !(cause instanceof DOMException)) {
                    throw new Error("expected an export exception");
                }
                return { name: cause.name, message: cause.message };
            }),
        ).toEqual({ name: "NotFoundError", message: "the destination is gone" });

        // The report entry point: a failed export is where the ring buffer still
        // holds the run that died.
        const report = page.locator("#export-panel-error .feedback-link");
        await expect(report).toBeVisible();
        await report.click();
        await expect(page.locator("#feedback-modal")).toBeVisible();
        await page.locator("#feedback-cancel").click();
        await expect(page.locator("#feedback-modal")).toBeHidden();
        await page.locator("#export-panel-error .export-panel__primary-btn").click();
        await expect(page.locator("#export-panel-save-btn")).toBeFocused();
    });

    test("re-encode: the failure keeps its class across the worker bridge", async ({ page, browserName }) => {
        test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
        test.setTimeout(120_000);
        // Fail the first write. A byte threshold would not do: the muxer buffers
        // into 4 MiB chunks, so a short clip reaches the destination as a single
        // write at the end and a small file would slip under any threshold - the
        // run would then only trip on the telemetry pass, which is a different
        // (soft, notify-only) path.
        await setup(page, { afterBytes: 0, errorName: "NotFoundError" });
        test.skip(
            !(await canEncodeHighProfileH264(page)),
            "WebCodecs High-profile H.264 encode not available on this platform",
        );

        // Below the top tier -> re-encode in the worker (the top tier stream-copies).
        await page.locator('input[name="export-panel-quality"][value="medium"]').check();
        await page.locator("#export-panel-save-btn").click();

        const status = page.locator(".export-panel__error-status");
        await expect(status).toBeVisible({ timeout: 100_000 });
        await expect(status, "the DOMException name must survive the port hop").toContainText(
            "the file being written is gone",
        );
    });
});

// No native save picker (Android Chrome / Firefox / Safari): the export must NOT
// hang at "Finalizing" (the old ponyfill SW-streaming bug). It buffers the MP4
// in RAM and offers it via a done-view Download button. This is the regression
// gate for that fix.
test.describe("export run (in-memory, no native FSA)", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await installInMemoryExportCapture(page); // before gotoApp - patched at bundle load
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page);
    });

    test("stream-copy buffers in memory and offers a Download button with a valid MP4", async ({ page }) => {
        // Single channel -> stream-copy. GPMF kept by default; on the in-memory
        // handle the in-place truncate + tail write before the commit works too.
        const includes = page.locator(".top-panel__channel-include");
        await expect(includes).toHaveCount(3);
        await includes.nth(2).click();
        await includes.nth(1).click();
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);

        // Degraded-notice half of graceful degradation: on a no-native-FSA browser
        // the panel must warn that the export builds in RAM BEFORE the user commits.
        // (The stub hides showSaveFilePicker -> nativeFsaAvailable() is false.)
        await expect(page.locator("#export-panel-fallback-warn")).toBeVisible();

        await page.locator("#export-panel-save-btn").click();
        // Must reach Done (not stuck at Finalizing) and surface a Download button.
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });
        const downloadBtn = page.locator("#export-panel-done-summary button");
        await expect(downloadBtn).toBeVisible();
        await downloadBtn.click();

        const r = await readInMemoryDownload(page);
        expect(r, "a video/mp4 blob must have been offered for download").not.toBeNull();
        expect(r!.len, "produced MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp).toBe(true);
        expect(r!.moov).toBe(true);
        expect(r!.mdat).toBe(true);
        expect(r!.gpmd, "GPMF track must inject on the in-memory handle too").toBe(true);
        expect(r!.soun, "audio must be copied into the in-memory stream-copy export").toBe(true);
    });

    test("re-encode buffers in memory and injects GPMF into the open in-memory output", async ({
        page,
        browserName,
    }) => {
        // The only end-to-end coverage of this wiring: worker mux ->
        // createWorkerWritableProxy (deferred commit) -> before-commit hook with
        // the moov the worker captured -> injectGpmdTrackIntoOpen on the
        // InMemoryMuxWritable -> commit -> takeDownloadBlob. The re-open fallback
        // (no captured moov: getFile snapshot + findMoovInFile) has unit coverage
        // only. Keep all 3 channels -> split-screen -> re-encode.
        // Firefox: H.264 encode is broken (Bugzilla 1918769); skip Gecko explicitly
        // (the probe below can't detect it - isConfigSupported lies).
        test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
        test.skip(
            !(await canEncodeHighProfileH264(page)),
            "WebCodecs High-profile H.264 encode not available on this platform",
        );
        test.setTimeout(120_000);
        await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(3);

        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 100_000 });
        const downloadBtn = page.locator("#export-panel-done-summary button");
        await expect(downloadBtn).toBeVisible();
        await downloadBtn.click();

        const r = await readInMemoryDownload(page);
        expect(r, "a video/mp4 blob must have been offered for download").not.toBeNull();
        expect(r!.len, "re-encoded MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp).toBe(true);
        expect(r!.moov).toBe(true);
        expect(r!.mdat).toBe(true);
        expect(r!.gpmd, "GPMF must inject on the in-memory re-encode (snapshot+walk) path").toBe(true);
        expect(r!.soun, "audio (AAC passthrough) must survive the in-memory re-encode export").toBe(true);
    });
});

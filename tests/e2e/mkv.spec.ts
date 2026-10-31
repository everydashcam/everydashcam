// Matroska (.mkv) container support. Browsers do not play Matroska through
// <video>.src (only WebM), so every .mkv routes through the per-file MSE-remux
// backend: mediabunny demuxes it and the worker remuxes to fragmented MP4. This
// is the same path TS/HEVC take, but the fixture is H.264 - which decodes on
// every runner including CI Chrome - so both assertions run unconditionally (no
// self-skip, unlike hevc.spec.ts).
//
// Covers playback of an .mkv and export from one. The sample carries no GPS, so
// export is a plain stream-copy with no gpmd track; the AAC audio must survive
// the remux into the output.

import {
    DESKTOP,
    SAMPLE_MKV,
    canEncodeHighProfileH264,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    readExportResult,
    shot,
    test,
} from "./_fixtures.js";

test.describe("mkv (matroska) container", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await installExportCapture(page); // before gotoApp - captured at bundle load
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
    });

    test("plays back through the MSE remux backend", async ({ page }) => {
        await loadTrip(page, SAMPLE_MKV);
        // loadTrip resolves on the chart/duration, which can precede the async
        // MSE backend attach. Wait for a decoded frame, then pause the autoplay
        // before clicking Play so the click cannot toggle playback back off.
        await expect
            .poll(
                () =>
                    page.evaluate(() => {
                        const v = document.getElementById("player") as HTMLVideoElement | null;
                        return v?.src.startsWith("blob:") ? v.readyState : 0;
                    }),
                { timeout: 15_000 },
            )
            .toBeGreaterThanOrEqual(2);
        await pausePlayback(page);
        await page.evaluate(() => {
            (document.getElementById("player") as HTMLVideoElement).currentTime = 0;
        });
        await expect
            .poll(() => page.evaluate(() => !(document.getElementById("player") as HTMLVideoElement).seeking))
            .toBe(true);
        // Require real playback: currentTime advances only if the remuxed
        // segments fed to MediaSource actually decode - i.e. mediabunny read the
        // Matroska stream and the fMP4 output is valid.
        await page.locator("#player-play").click();
        await expect
            .poll(() => page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).currentTime), {
                timeout: 8000,
            })
            .toBeGreaterThan(0.25);
        await shot(page, "mkv-01-playing");
    });

    test("zoom preview mirrors an MSE-backed video", async ({ page }) => {
        // A second <video> cannot attach the master's MediaSource; the canvas
        // mirror draws whatever the master presents instead.
        await loadTrip(page, SAMPLE_MKV);
        await expect
            .poll(() => page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).readyState))
            .toBeGreaterThanOrEqual(2);
        await pausePlayback(page);
        await page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)").hover();
        await page.mouse.wheel(0, -120);
        await expect(page.locator("#video-minimap")).toBeVisible();
        await expect
            .poll(() =>
                page.locator("#video-minimap-canvas").evaluate((canvas: HTMLCanvasElement) => {
                    if (canvas.width === 0 || canvas.height === 0) return false;
                    const pixel = canvas
                        .getContext("2d")!
                        .getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
                    return pixel[3] === 255;
                }),
            )
            .toBe(true);
    });

    test("plays through ManagedMediaSource when classic MediaSource is absent", async ({ page }) => {
        // iPhone Safari exposes only ManagedMediaSource. Chromium lacks it, so
        // the classic constructor stands in under the managed name; this covers
        // constructor selection and the remote-playback opt-out, not WebKit's
        // own eviction policy.
        await page.addInitScript(() => {
            const scope = window as unknown as Record<string, unknown>;
            scope.ManagedMediaSource = scope.MediaSource;
            delete scope.MediaSource;
        });
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_MKV);
        await expect
            .poll(
                () =>
                    page.evaluate(() => {
                        const v = document.getElementById("player") as HTMLVideoElement | null;
                        return v?.src.startsWith("blob:") ? v.readyState : 0;
                    }),
                { timeout: 15_000 },
            )
            .toBeGreaterThanOrEqual(2);
        expect(
            await page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).disableRemotePlayback),
            "managed media source requires remote playback to be disabled",
        ).toBe(true);
        await pausePlayback(page);
        await page.evaluate(() => {
            (document.getElementById("player") as HTMLVideoElement).currentTime = 0;
        });
        await expect
            .poll(() => page.evaluate(() => !(document.getElementById("player") as HTMLVideoElement).seeking))
            .toBe(true);
        await page.locator("#player-play").click();
        await expect
            .poll(() => page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).currentTime), {
                timeout: 8000,
            })
            .toBeGreaterThan(0.25);
    });

    test("exports to a valid MP4 (stream-copy, audio preserved)", async ({ page }) => {
        await loadTrip(page, SAMPLE_MKV);
        await openExport(page);
        // Single camera, no transforms -> stream-copy. Save through the stubbed
        // in-memory handle and inspect the bytes the pipeline produced.
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });

        const r = await readExportResult(page);
        expect(r, "export must have written bytes through the stubbed handle").not.toBeNull();
        expect(r!.len, "produced MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp, "MP4 must have an ftyp box").toBe(true);
        expect(r!.moov, "MP4 must have a moov box").toBe(true);
        expect(r!.mdat, "MP4 must have media data").toBe(true);
        // No GPS in the source -> no telemetry track to inject.
        expect(r!.gpmd, "no GPS source -> no gpmd track").toBe(false);
        // AAC audio must be stream-copied out of the Matroska container.
        expect(r!.soun, "AAC audio must be copied into the export").toBe(true);
        await shot(page, "mkv-02-exported");
    });

    test("re-encode export (crop) remuxes MKV video to a clean MP4 and keeps audio", async ({ page }) => {
        // A crop forces the DECODE->composite->re-encode pipeline (not stream-copy),
        // which is where a Matroska source used to break: mediabunny's decoder
        // aborts on the degenerate packets some viewer re-exports carry. The fix
        // normalizes any .mkv into a clean stream-copy MP4 for the video decode
        // path (this clean fixture has no degenerate packets, so it exercises the
        // redirect plumbing itself), while AAC audio still reads the original file
        // through a separate input - the audioInput split. Self-skips where the
        // runner cannot encode High-profile H.264.
        await loadTrip(page, SAMPLE_MKV);
        await expect(page.locator("#player-export")).toBeEnabled({ timeout: 30_000 });
        const canEncode = await canEncodeHighProfileH264(page);
        test.skip(!canEncode, "runner cannot encode High-profile H.264");

        await openExport(page);
        await page.locator('#video-grid .video-tile[data-channel="front"]').dblclick();
        const handle = page.locator(".crop-handle--br");
        await expect(handle).toBeVisible();
        const box = (await handle.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x - 90, box.y - 60, { steps: 8 });
        await page.mouse.up();

        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 120_000 });

        const r = await readExportResult(page);
        expect(r, "export must have written bytes").not.toBeNull();
        expect(r!.ftyp && r!.moov && r!.mdat, "produced a valid MP4").toBe(true);
        expect(r!.soun, "AAC audio must survive the video redirect (audioInput split)").toBe(true);
        await shot(page, "mkv-03-reencode-crop");
    });
});

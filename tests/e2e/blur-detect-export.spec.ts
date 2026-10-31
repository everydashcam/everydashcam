import { installWorkerRpc } from "./_worker-rpc.js";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    DESKTOP,
    SAMPLE_70MAI,
    expect,
    gotoApp,
    hasWebGpuAdapter,
    installExportCapture,
    openExport,
    presetLocalStorage,
    readExportResult,
    readTranscodeDoneFields,
    test,
} from "./_fixtures.js";

test("Save keeps an adopted detection pass when playback switches trips", async ({ page }) => {
    test.setTimeout(120_000);
    await presetLocalStorage(page);
    await installExportCapture(page);
    await installWorkerRpc(page, () => {
        const target = window as typeof window & {
            __detectResponseHeld?: boolean;
            __releaseDetectResponse?: () => void;
        };
        let released = false;
        const pending: Array<() => void> = [];
        target.__releaseDetectResponse = () => {
            released = true;
            for (const deliver of pending.splice(0)) deliver();
        };
        window.__workerRpc.intercept(["tracker-worker"], () => async (type, _data, forward) => {
            const result = await forward();
            if (type === "detect" && !released) {
                target.__detectResponseHeld = true;
                await new Promise<void>((resolve) => pending.push(resolve));
            }
            return result;
        });
    });
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable - detection is WebGPU-only");

    const buffer = readFileSync(path.join(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4"));
    await page.locator("#file-input").setInputFiles([
        { name: "NO20260101-120000-000001F.MP4", mimeType: "video/mp4", buffer },
        { name: "NO20260102-120000-000001F.MP4", mimeType: "video/mp4", buffer },
    ]);
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(2);
    await trips.first().locator(".trip-header").click();
    await page.locator(".video-tile:not([hidden]) .camera-settings-button").click();
    await page.getByRole("menuitemcheckbox", { name: "Flip horizontally" }).click();
    await page.keyboard.press("Escape");
    await openExport(page);
    await page.locator('input[name="export-panel-quality"][value="original"]').check();
    await page.locator("#export-panel-watermark").uncheck();
    await page.locator("#export-panel-blur-plates").check();
    await page.locator(".export-panel__blur-detect-strip").getByRole("button", { name: "Download & scan" }).click();
    await expect
        .poll(() =>
            page.evaluate(() => (window as typeof window & { __detectResponseHeld?: boolean }).__detectResponseHeld),
        )
        .toBe(true);

    await page.locator("#export-panel-save-btn").click();
    await expect(page.getByText("Finding plates and faces...", { exact: true })).toBeVisible();
    // Export hides the sidebar, but playback can still advance the active
    // trip. Exercise its navigation handler while Save awaits this response.
    await trips.last().locator(".trip-header").dispatchEvent("click");
    await expect(trips.last()).toHaveClass(/\bactive\b/);
    await page.evaluate(() => {
        const release = (window as typeof window & { __releaseDetectResponse?: () => void }).__releaseDetectResponse;
        if (!release) throw new Error("detect response release missing");
        release();
    });
    await expect.poll(async () => (await readExportResult(page))?.len ?? 0, { timeout: 60_000 }).toBeGreaterThan(1024);
    const result = await readExportResult(page);
    expect(result?.ftyp).toBe(true);
    expect(result?.moov).toBe(true);
    expect(result?.mdat).toBe(true);
    const done = await readTranscodeDoneFields(page);
    expect(done, "an empty detection result cannot bypass camera reflection").not.toBeNull();
    expect(done!.framesEncoded).toBeGreaterThan(0);
    expect(done!.framesDirect).toBe(0);
});

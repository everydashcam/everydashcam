import { installWorkerRpc } from "./_worker-rpc.js";
import type { Page } from "@playwright/test";
import type { DetectResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import {
    DESKTOP,
    canEncodeHighProfileH264,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    readExportResult,
    readTranscodeDoneFields,
    test,
} from "./_fixtures.js";

test.use({ serviceWorkers: "block" });

async function openBlurProgress(page: Page): Promise<void> {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await installWorkerRpc(
        page,
        (urls: string[]) => {
            // Exercise UI updates at the worker boundary without making inference
            // speed or GPU availability part of this DOM contract. The real local
            // asset bytes still pass the same integrity gate as production.
            Object.defineProperty(navigator, "gpu", {
                value: { requestAdapter: async () => ({}) },
                configurable: true,
            });
            for (const url of urls) localStorage.setItem(`everydashcam:blurAssetDownloaded:${url}`, "1");
            let completeFutureDetections = false;
            let detectionRequests = 0;
            window.__workerRpc.intercept(["tracker-worker"], (worker) => {
                const progressData = new Map<string, object>();
                const pendingDetections = new Set<(result: DetectResult) => void>();
                const completeDetections = () => {
                    for (const resolve of pendingDetections)
                        resolve({
                            tracksByKind: {},
                            statsByKind: {},
                            sourceFrames: [],
                            decodedFrames: 0,
                            passMs: 0,
                        });
                    pendingDetections.clear();
                };
                window.addEventListener("e2e:detect-empty-current", completeDetections);
                window.addEventListener("e2e:detect-empty", () => {
                    completeFutureDetections = true;
                    completeDetections();
                });
                for (const type of ["track", "detect"]) {
                    window.addEventListener(`e2e:${type}-progress`, (event) => {
                        if (!(event instanceof CustomEvent) || typeof event.detail !== "number") return;
                        const data = progressData.get(type);
                        if (!data) throw new Error("blur request missing");
                        void worker.notify(`${type}-progress`, { ...data, fractionDone: event.detail });
                    });
                }
                return (type, data, forward) => {
                    if ((type !== "track" && type !== "detect") || !data || typeof data !== "object") return forward();
                    progressData.set(type, data);
                    document.documentElement.setAttribute(`data-${type}-requested`, "true");
                    if (type === "track") return new Promise(() => {});
                    document.documentElement.setAttribute("data-detect-request-count", String(++detectionRequests));
                    return new Promise<DetectResult>((resolve) => {
                        pendingDetections.add(resolve);
                        // Saving can discover more source windows after the first reply.
                        if (completeFutureDetections) queueMicrotask(completeDetections);
                    });
                };
            });
        },
        computeTrackerAssets("build").urls,
    );
    await gotoApp(page, "en");
    await loadTrip(page);
    await openExport(page);
    const includes = page.locator(".top-panel__channel-include");
    await includes.nth(2).click();
    await includes.nth(1).click();
    await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);
    await pausePlayback(page);
}

async function addCenteredZone(page: Page): Promise<void> {
    const rows = page.locator(".export-panel__blur-row");
    const count = await rows.count();
    await page.locator(".export-panel__blur-add-btn").click();
    await page.locator(".blur-draw-layer").press("Enter");
    await expect(rows).toHaveCount(count + 1);
}

test("Follow progress preserves zone rows and keyboard focus", async ({ page }) => {
    await openBlurProgress(page);
    await addCenteredZone(page);
    await addCenteredZone(page);
    await expect(page.locator(".export-panel__blur-row")).toHaveCount(2);
    const follow = page.locator(".export-panel__blur-follow-btn").first();
    await follow.click();
    await expect(page.locator("html")).toHaveAttribute("data-track-requested", "true");
    await expect(follow).toHaveText("Following… 0%");
    await follow.focus();

    const changes = await page.evaluate(async () => {
        const rows = [...document.querySelectorAll(".export-panel__blur-row")];
        const list = rows[0]?.parentElement;
        if (!list) throw new Error("blur rows missing");
        const focus = document.activeElement;
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true });
        for (let pct = 1; pct <= 100; pct++) {
            window.dispatchEvent(new CustomEvent("e2e:track-progress", { detail: pct / 100 }));
        }
        const rowMutations = observer.takeRecords().length;
        observer.disconnect();
        return {
            rowMutations,
            sameRows: rows.every((row, index) => list.children[index] === row),
            sameFocus: document.activeElement === focus,
        };
    });

    expect(changes).toEqual({ rowMutations: 0, sameRows: true, sameFocus: true });
    await expect(follow).toHaveText("Following… 100%");
    await expect(page.locator("#export-panel-save-btn")).toBeDisabled();
    await follow.click();
    await expect(follow).toHaveText("Follow");
});

test("detection progress updates its bar without rebuilding nodes or repainting paused masks", async ({ page }) => {
    await openBlurProgress(page);
    await addCenteredZone(page);
    await page.locator("#export-panel-blur-plates").check();
    await expect(page.locator("html")).toHaveAttribute("data-detect-requested", "true");
    const status = page.locator(".export-panel__blur-detect-status");
    await expect(status.getByRole("progressbar")).toBeVisible();

    const advanceProgress = () =>
        page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            const status = document.querySelector(".export-panel__blur-detect-status");
            const bar = status?.querySelector('[role="progressbar"]');
            if (!status || !bar) throw new Error("detection progress missing");
            let repaints = 0;
            const nativeClear = CanvasRenderingContext2D.prototype.clearRect;
            CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
                if (this.canvas.classList.contains("blur-preview-canvas")) repaints++;
                nativeClear.call(this, x, y, w, h);
            };
            const observer = new MutationObserver(() => {});
            observer.observe(status, { childList: true });
            let replacedStatusNodes = 0;
            try {
                for (let pct = 1; pct <= 100; pct++) {
                    window.dispatchEvent(new CustomEvent("e2e:detect-progress", { detail: pct / 100 }));
                    replacedStatusNodes += observer.takeRecords().length;
                    await new Promise(requestAnimationFrame);
                }
                await new Promise(requestAnimationFrame);
                return { replacedStatusNodes, sameBar: status.contains(bar), repaints };
            } finally {
                CanvasRenderingContext2D.prototype.clearRect = nativeClear;
                observer.disconnect();
            }
        });

    expect(await advanceProgress()).toEqual({ replacedStatusNodes: 0, sameBar: true, repaints: 0 });
    await expect(status.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await page.evaluate(() => window.dispatchEvent(new Event("e2e:detect-empty-current")));
    await expect(page.locator("html")).toHaveAttribute("data-detect-request-count", "2");
    // Completing a window commits its result and may repaint. Each progress
    // burst independently checks the steady-state DOM and paused-mask contract.
    expect(await advanceProgress()).toEqual({ replacedStatusNodes: 0, sameBar: true, repaints: 0 });
    await expect(status.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await page.locator("#export-panel-blur-plates").uncheck();
});

test("an empty detection result preserves the manual bitrate captured at Save", async ({ page, browserName }) => {
    test.skip(browserName === "firefox", "Firefox WebCodecs H.264 encode is broken (Bugzilla 1918769)");
    test.setTimeout(120_000);
    await installExportCapture(page);
    await openBlurProgress(page);
    test.skip(
        !(await canEncodeHighProfileH264(page)),
        "WebCodecs High-profile H.264 encode not available on this platform",
    );
    await expect(page.locator("#export-panel-output")).toHaveValue("source");
    await expect(page.locator('input[name="export-panel-quality"][value="original"]')).toBeChecked();
    await page.locator("#export-panel-watermark").uncheck();
    await page.locator(".export-panel__manual-bitrate > summary").click();
    const manual = page.locator("#export-panel-bitrate");
    await manual.fill("2");
    await manual.blur();
    await page.locator("#export-panel-blur-plates").check();
    await expect(page.locator("html")).toHaveAttribute("data-detect-requested", "true");
    await page.locator("#export-panel-save-btn").click();
    await expect(page.getByText("Finding plates and faces...", { exact: true })).toBeVisible();

    // The running export owns its captured bitrate even if later state changes.
    await manual.evaluate((input: HTMLInputElement) => {
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.evaluate(() => window.dispatchEvent(new Event("e2e:detect-empty")));
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 90_000 });
    expect((await readExportResult(page))?.mdat).toBe(true);
    const done = await readTranscodeDoneFields(page);
    expect(done?.framesEncoded, "empty detection must not turn a manual encode into a source copy").toBeGreaterThan(0);
    expect(
        await page.evaluate(
            () =>
                window.__everydashcam
                    .dumpLog()
                    .reverse()
                    .find((record) => record.msg === "export settings")?.ctx,
        ),
    ).toMatchObject({ mode: "single", manualBitrateMbps: 2, encodeBitrate: 2_000_000 });
});

test.describe("missing retained assets", () => {
    test.use({
        tolerateConsole: [/^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/],
    });
    test("asks for an update without reloading a loaded recording", async ({ page }) => {
        await page.route("**/ort/**", (route) => route.fulfill({ status: 404, body: "missing version" }));
        await openBlurProgress(page);
        await page.evaluate(() => {
            document.documentElement.dataset.updateSentinel = "kept";
        });
        await page.locator("#export-panel-blur-plates").check();
        await expect(
            page.getByText("This version can no longer download what it needs.", { exact: false }),
        ).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-update-sentinel", "kept");
        await expect(page.locator("html")).not.toHaveAttribute("data-detect-requested", "true");
        await expect(page.locator("#export-panel-blur-plates")).toBeChecked();
    });
});

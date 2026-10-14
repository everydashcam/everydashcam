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
    await page.addInitScript((urls: string[]) => {
        // Exercise UI updates at the worker boundary without making inference
        // speed, model downloads or GPU availability part of this DOM contract.
        Object.defineProperty(navigator, "gpu", {
            value: { requestAdapter: async () => ({}) },
            configurable: true,
        });
        for (const url of urls) localStorage.setItem(`everydashcam:blurAssetDownloaded:${url}`, "1");
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
            return urls.includes(url)
                ? Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
                : nativeFetch(input, init);
        };
        const NativeWorker = window.Worker;
        let completeFutureDetections = false;
        let detectionRequests = 0;
        window.Worker = class extends NativeWorker {
            private isTracker: boolean;
            private progressData = new Map<string, object>();
            private pendingDetections = new Set<number>();

            constructor(scriptURL: string | URL, options?: WorkerOptions) {
                super(scriptURL, options);
                this.isTracker = options?.name === "tracker-worker";
                if (!this.isTracker) return;
                window.addEventListener("e2e:detect-empty-current", () => this.completeDetections());
                window.addEventListener("e2e:detect-empty", () => {
                    completeFutureDetections = true;
                    this.completeDetections();
                });
                for (const type of ["track", "detect"]) {
                    window.addEventListener(`e2e:${type}-progress`, (event) => {
                        if (!(event instanceof CustomEvent) || typeof event.detail !== "number") return;
                        const data = this.progressData.get(type);
                        if (!data) throw new Error("blur request missing");
                        this.dispatchEvent(
                            new MessageEvent("message", {
                                data: {
                                    __k: "ntf",
                                    type: `${type}-progress`,
                                    data: { ...data, fractionDone: event.detail },
                                },
                            }),
                        );
                    });
                }
            }

            private completeDetections(): void {
                const pending = [...this.pendingDetections];
                this.pendingDetections.clear();
                for (const id of pending) {
                    const result: DetectResult = {
                        tracksByKind: {},
                        statsByKind: {},
                        sourceFrames: [],
                        decodedFrames: 0,
                        passMs: 0,
                    };
                    this.dispatchEvent(new MessageEvent("message", { data: { __k: "res", id, ok: true, result } }));
                }
            }

            override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
                if (this.isTracker && message && typeof message === "object" && "__k" in message) {
                    if (message.__k === "abort") return;
                    if (
                        message.__k === "req" &&
                        "type" in message &&
                        (message.type === "track" || message.type === "detect") &&
                        "data" in message &&
                        message.data &&
                        typeof message.data === "object"
                    ) {
                        this.progressData.set(message.type, message.data);
                        document.documentElement.setAttribute(`data-${message.type}-requested`, "true");
                        if (message.type === "detect" && "id" in message && typeof message.id === "number") {
                            this.pendingDetections.add(message.id);
                            document.documentElement.setAttribute(
                                "data-detect-request-count",
                                String(++detectionRequests),
                            );
                            // Save can discover further source windows after
                            // the first reply; release those requests too.
                            if (completeFutureDetections) queueMicrotask(() => this.completeDetections());
                        }
                        return;
                    }
                }
                if (Array.isArray(options)) super.postMessage(message, options);
                else super.postMessage(message, options);
            }
        };
    }, computeTrackerAssets("build").urls);
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

// Layout-instability regressions at the async seams that analytics sees:
// startup hydration, the first folder ingest, a late-loading lightbox image and
// the pointer-driven chart tooltip. The raw score intentionally includes shifts
// with recent input; a fast CI ingest can finish inside CLS's 500ms input
// exclusion while the same folder on a real SD card does not.

import type { Page } from "@playwright/test";

import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    expect,
    gotoApp,
    loadTrip,
    mockDirectoryPicker,
    persistentTest as test,
    presetLocalStorage,
} from "./_fixtures.js";

interface LayoutShiftRecord {
    value: number;
    hadRecentInput: boolean;
    sources: string[];
}

interface LayoutShiftReport {
    supported: boolean;
    records: LayoutShiftRecord[];
}

async function installLayoutShiftObserver(page: Page): Promise<void> {
    await page.addInitScript(() => {
        interface ShiftEntry extends PerformanceEntry {
            value: number;
            hadRecentInput: boolean;
            sources?: Array<{ node?: Node | null }>;
        }

        interface ShiftWindow extends Window {
            __layoutShiftObserver?: PerformanceObserver;
            __layoutShiftRecords: LayoutShiftRecord[];
            __layoutShiftSupported: boolean;
        }

        const shiftWindow = window as unknown as ShiftWindow;
        shiftWindow.__layoutShiftRecords = [];
        shiftWindow.__layoutShiftSupported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
        if (!shiftWindow.__layoutShiftSupported) return;

        const labelFor = (node: Node | null | undefined): string => {
            if (!(node instanceof Element)) return node?.nodeName.toLowerCase() ?? "unknown";
            if (node.id) return `#${node.id}`;
            const classes = [...node.classList].slice(0, 2).join(".");
            return `${node.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
        };
        const observer = new PerformanceObserver((list) => {
            for (const rawEntry of list.getEntries()) {
                const entry = rawEntry as ShiftEntry;
                shiftWindow.__layoutShiftRecords.push({
                    value: entry.value,
                    hadRecentInput: entry.hadRecentInput,
                    sources: (entry.sources ?? []).map((source) => labelFor(source.node)),
                });
            }
        });
        observer.observe({ type: "layout-shift", buffered: true });
        shiftWindow.__layoutShiftObserver = observer;
    });
}

async function readLayoutShiftReport(page: Page): Promise<LayoutShiftReport> {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
    });
    return page.evaluate(() => {
        const shiftWindow = window as Window & {
            __layoutShiftRecords?: LayoutShiftRecord[];
            __layoutShiftSupported?: boolean;
        };
        return {
            supported: shiftWindow.__layoutShiftSupported ?? false,
            records: shiftWindow.__layoutShiftRecords ?? [],
        };
    });
}

function rawLayoutShiftScore(report: LayoutShiftReport): number {
    return report.records.reduce((total, record) => total + record.value, 0);
}

/** Drops the shifts recorded so far so the next report covers only the step under test. */
async function resetLayoutShiftRecords(page: Page): Promise<void> {
    await page.evaluate(() => {
        const shiftWindow = window as Window & {
            __layoutShiftObserver?: PerformanceObserver;
            __layoutShiftRecords?: LayoutShiftRecord[];
        };
        shiftWindow.__layoutShiftObserver?.takeRecords();
        shiftWindow.__layoutShiftRecords = [];
    });
}

test.describe("layout stability", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await presetLocalStorage(page);
    });

    test("keeps the topbar and final app grid fixed as async UI appears", async ({ page }) => {
        await installLayoutShiftObserver(page);
        await gotoApp(page, "en");
        await expect(page.locator("#landing")).toBeVisible();

        const whatsNew = page.locator("#whats-new-btn");
        const offlineUse = page.locator("#offline-use-btn");
        await expect(offlineUse).toBeVisible();
        const beforeInstall = await whatsNew.boundingBox();
        const offlineBefore = await offlineUse.boundingBox();
        expect(beforeInstall, "what's-new button has initial geometry").not.toBeNull();
        expect(offlineBefore, "offline-use button has initial geometry").not.toBeNull();

        // Chromium supplies this event after installability checks, well after
        // first paint. The synthetic event drives the same production handler.
        await page.evaluate(() => {
            dispatchEvent(new Event("beforeinstallprompt", { cancelable: true }));
        });
        await expect(offlineUse).toBeVisible();
        const afterInstall = await whatsNew.boundingBox();
        expect(afterInstall, "what's-new button keeps geometry after install eligibility changes").not.toBeNull();
        expect(
            Math.abs(afterInstall!.x - beforeInstall!.x),
            "install eligibility does not move #whats-new-btn",
        ).toBeLessThan(0.5);
        expect(await offlineUse.boundingBox(), "install eligibility preserves the offline-use button").toEqual(
            offlineBefore,
        );

        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
        await expect(page.locator("#landing"), "the FLIP transition settles and detaches the landing").toHaveCount(0);

        const report = await readLayoutShiftReport(page);
        expect(report.supported, "Chromium exposes layout-shift performance entries").toBe(true);
        expect(rawLayoutShiftScore(report), `raw layout shifts: ${JSON.stringify(report.records)}`).toBeLessThanOrEqual(
            0.02,
        );
    });

    test("settles remembered-folder geometry before the splash reveals the landing", async ({ page }) => {
        await mockDirectoryPicker(page, [{ label: "MOCKCARD", dir: SAMPLE_70MAI }]);
        await gotoApp(page, "en");
        await page.locator("#landing-cta").click();
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
        await page.locator("#folder-sources .folder-source__remember").click();
        await expect(page.locator("#folder-sources .folder-source__state")).toBeVisible();

        await installLayoutShiftObserver(page);
        await page.addInitScript(() => {
            const readyWindow = window as Window & {
                __recentFoldersAtReady?: { hidden: boolean | null; count: number };
            };
            addEventListener(
                "dc:ready",
                () => {
                    const recent = document.getElementById("recent-folders");
                    readyWindow.__recentFoldersAtReady = {
                        hidden: recent instanceof HTMLElement ? recent.hasAttribute("hidden") : null,
                        count: document.querySelectorAll("#recent-folders-list .recent-folder-chip").length,
                    };
                },
                { once: true },
            );
        });

        await page.reload();
        await expect(page.locator("#recent-folders")).toBeVisible();
        await expect(page.locator("#recent-folders-list .recent-folder-chip")).toHaveCount(1);
        const readySnapshot = await page.evaluate(
            () =>
                (
                    window as Window & {
                        __recentFoldersAtReady?: { hidden: boolean | null; count: number };
                    }
                ).__recentFoldersAtReady,
        );
        expect(readySnapshot, "dc:ready is dispatched after recent folders render").toEqual({
            hidden: false,
            count: 1,
        });

        const report = await readLayoutShiftReport(page);
        expect(report.supported, "Chromium exposes layout-shift performance entries").toBe(true);
        expect(rawLayoutShiftScore(report), `raw layout shifts: ${JSON.stringify(report.records)}`).toBeLessThanOrEqual(
            0.02,
        );
    });

    test("keeps the hero-shot lightbox box fixed while the full-size shot arrives", async ({ page }) => {
        // Hold the full-size file so it lands well past CLS's 500ms input
        // exclusion after the click, as on a slow connection.
        let releaseFullShot = (): void => {};
        const fullShotGate = new Promise<void>((resolve) => {
            releaseFullShot = resolve;
        });
        await page.route("**/landing/app-desktop-2480.webp", async (route) => {
            await fullShotGate;
            await route.continue();
        });
        await installLayoutShiftObserver(page);
        await gotoApp(page, "en");

        const thumb = page.locator(".landing-hero-shot-desktop");
        await expect
            .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
            .toBe(true);
        const thumbSrc = await thumb.evaluate((img: HTMLImageElement) => img.currentSrc);
        expect(thumbSrc, "a 1x desktop viewport picks the smaller hero file").toMatch(/app-desktop-1240\.webp$/);

        await page.locator("#landing-shot-open").click();
        const shot = page.locator(".landing-shot-lightbox-desktop");
        await expect(shot).toBeVisible();
        // offset* ignore the opening scale animation, unlike boundingBox().
        const readGeometry = () =>
            shot.evaluate((img: HTMLImageElement) => ({
                left: img.offsetLeft,
                top: img.offsetTop,
                width: img.offsetWidth,
                height: img.offsetHeight,
            }));
        await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.currentSrc)).toBe(thumbSrc);
        const loadingGeometry = await readGeometry();
        expect(loadingGeometry.width, "the box is reserved before the full-size file arrives").toBeGreaterThan(
            DESKTOP.width / 2,
        );
        expect(loadingGeometry.width / loadingGeometry.height, "the reserved box keeps the shot ratio").toBeCloseTo(
            2480 / 1378,
            1,
        );

        await resetLayoutShiftRecords(page);
        releaseFullShot();
        await expect
            .poll(() => shot.evaluate((img: HTMLImageElement) => img.currentSrc))
            .toMatch(/app-desktop-2480\.webp$/);
        expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth), "the full-size file is shown").toBe(
            2480,
        );
        expect(await readGeometry(), "the swap keeps the reserved box").toEqual(loadingGeometry);

        const report = await readLayoutShiftReport(page);
        expect(report.supported, "Chromium exposes layout-shift performance entries").toBe(true);
        expect(rawLayoutShiftScore(report), `raw layout shifts: ${JSON.stringify(report.records)}`).toBeLessThanOrEqual(
            0.001,
        );
    });

    test("moves the chart tooltip with the cursor without layout shifts", async ({ page }) => {
        await installLayoutShiftObserver(page);
        await gotoApp(page, "en");
        await loadTrip(page);

        const chart = page.locator("#player-chart-canvas");
        await expect(chart).toBeVisible();
        const chartBox = await chart.boundingBox();
        expect(chartBox, "the chart has hover geometry").not.toBeNull();
        const hoverY = chartBox!.y + chartBox!.height / 2;
        await page.mouse.move(chartBox!.x + chartBox!.width * 0.2, hoverY);
        const tooltip = page.locator(".ez-chart-tooltip");
        await expect(tooltip).toHaveCSS("opacity", "1");
        const tooltipBefore = await tooltip.boundingBox();
        expect(tooltipBefore, "the tooltip has initial geometry").not.toBeNull();

        // Pointer movement is not recent input for CLS, so every tooltip move
        // that changes layout position counts against the page.
        await resetLayoutShiftRecords(page);
        await page.mouse.move(chartBox!.x + chartBox!.width * 0.6, hoverY, { steps: 12 });
        await expect
            .poll(async () => (await tooltip.boundingBox())?.x ?? 0, { message: "the tooltip follows the cursor" })
            .toBeGreaterThan(tooltipBefore!.x + chartBox!.width * 0.3);

        const report = await readLayoutShiftReport(page);
        expect(report.supported, "Chromium exposes layout-shift performance entries").toBe(true);
        expect(rawLayoutShiftScore(report), `raw layout shifts: ${JSON.stringify(report.records)}`).toBeLessThanOrEqual(
            0.001,
        );
    });
});

test.describe("mobile offline layout stability", () => {
    test.use({ viewport: MOBILE, hasTouch: true, isMobile: true });

    test("shows connectivity status without moving or covering the shell controls", async ({ page, context }) => {
        await presetLocalStorage(page);
        await installLayoutShiftObserver(page);
        await gotoApp(page, "en");
        await expect(page.locator("#landing")).toBeVisible();
        await expect(page.locator("#dc-loader")).toHaveCount(0);
        const startupReport = await readLayoutShiftReport(page);
        expect(
            rawLayoutShiftScore(startupReport),
            `mobile startup layout shifts: ${JSON.stringify(startupReport.records)}`,
        ).toBeLessThanOrEqual(0.02);
        // Measure the offline transition after startup and font layout settle.
        await resetLayoutShiftRecords(page);

        const mainBefore = await page.locator("main.layout").boundingBox();
        expect(mainBefore, "main has settled mobile geometry").not.toBeNull();

        await context.setOffline(true);
        const banner = page.locator("#offline-banner");
        await expect(banner).toBeVisible();
        const [mainAfter, bannerBox, brandBox, overflowBox] = await Promise.all([
            page.locator("main.layout").boundingBox(),
            banner.boundingBox(),
            page.locator(".dc-mark").boundingBox(),
            page.locator("#topbar-overflow").boundingBox(),
        ]);
        expect(mainAfter, "offline status preserves main geometry").toEqual(mainBefore);
        expect(bannerBox, "offline status has visible geometry").not.toBeNull();
        expect(brandBox, "mobile brand mark has visible geometry").not.toBeNull();
        expect(overflowBox, "secondary actions remain reachable from mobile overflow").not.toBeNull();
        await expect(page.locator("#feedback-btn")).toHaveAttribute("data-overflow-hidden", "true");
        expect(bannerBox!.x, "offline status stays after the brand mark").toBeGreaterThanOrEqual(
            brandBox!.x + brandBox!.width,
        );
        expect(bannerBox!.x + bannerBox!.width, "offline status stays before right-side controls").toBeLessThanOrEqual(
            overflowBox!.x,
        );

        const report = await readLayoutShiftReport(page);
        expect(report.supported, "Chromium exposes layout-shift performance entries").toBe(true);
        expect(rawLayoutShiftScore(report), `raw layout shifts: ${JSON.stringify(report.records)}`).toBeLessThanOrEqual(
            0.001,
        );

        await context.setOffline(false);
    });
});

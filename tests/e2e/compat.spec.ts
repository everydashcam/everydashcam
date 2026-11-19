// Browser-compatibility surfacing (src/capabilities.ts + ui/capability-gate.ts).
//
// We can't ship a real old browser to CI, so we simulate the two gaps by
// removing the capability from the page BEFORE the bundle evaluates
// (addInitScript runs pre-app), then assert the user-facing outcome:
//   - a FATAL gap (no Web Workers) -> the full blocking gate;
//   - a DEGRADED gap (no WebGL) -> a notice / WebGL guide, app still usable.
// The map gap surfaces LAZILY (first time the map fails to init, when the viewer
// opens), not over the bare landing, so every degraded test loads a trip first.
// The verdict routes by platform: desktop -> WebGL guide modal; mobile -> "use a
// computer" notice; unrecognized browser -> "try a mainstream browser" notice.

import type { Page } from "@playwright/test";

import {
    DESKTOP,
    SAMPLE_70MAI,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

/**
 * Force every WebGL context request to fail BEFORE the bundle evaluates, so the
 * capability probe (and MapLibre) see "no WebGL". The 2d context (Chart.js,
 * previews) is left intact, so video + chart + export keep working.
 */
async function killWebGL(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const proto = HTMLCanvasElement.prototype as unknown as {
            getContext: (type: string, ...rest: unknown[]) => unknown;
        };
        const orig = proto.getContext;
        proto.getContext = function patched(type: string, ...rest: unknown[]) {
            if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
            return orig.call(this, type, ...rest);
        };
    });
}

/**
 * Hide WebGPU so the "is a GPU alive?" cross-check in classifyWebglRecovery sees
 * nothing. With an unrecognized desktop browser UA this forces the NON-recoverable
 * verdict (the quiet "try a mainstream browser" notice instead of the modal).
 */
async function killWebGPU(page: Page): Promise<void> {
    await page.addInitScript(() => {
        try {
            Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
        } catch {
            /* non-configurable - best effort; headless Chromium usually lacks gpu anyway */
        }
    });
}

/**
 * Assert a degraded "no map" notice was surfaced carrying `text`. The toast
 * self-dismisses (warn severity = 8s in notifications.ts), so we gate on the
 * PERSISTENT bell-drawer entry instead of racing the toast's dismiss window;
 * opening the drawer also confirms the surfaced message is the expected one.
 */
async function expectMapNotice(page: Page, text: RegExp): Promise<void> {
    const bell = page.locator("#notif-bell");
    await expect(bell, "the notification bell appears once a notice fires").toBeVisible({ timeout: 15_000 });
    await bell.click();
    await expect(
        page.locator("#notif-drawer-list", { hasText: text }),
        "the bell drawer holds the surfaced map notice",
    ).toBeVisible();
}

test.describe("browser compatibility", () => {
    test("fatal gap (no Web Workers) shows the blocking gate", async ({ page }) => {
        // Remove Worker before app code runs. A getter returning undefined makes
        // `typeof Worker === "undefined"`, exactly what the probe checks.
        await page.addInitScript(() => {
            try {
                Object.defineProperty(window, "Worker", { configurable: true, get: () => undefined });
            } catch {
                /* already non-configurable - best effort */
            }
        });
        await presetLocalStorage(page);
        await gotoApp(page, "en");

        const gate = page.locator("#capability-gate");
        await expect(gate, "blocking gate must appear when Web Workers are missing").toBeVisible({ timeout: 15_000 });
        await expect(page.locator("#capability-gate-title")).toContainText(/can.?t run everydashcam/i);
        // The advice line names a concrete way out (update / switch browser).
        await expect(page.locator(".capability-gate-advice")).toContainText(/Chrome|Edge|Firefox|Safari/);
        // Technical details list the missing capability for bug reports.
        await expect(page.locator(".capability-gate-tech")).toContainText(/webWorker/);
    });

    // The map gap is surfaced LAZILY - the first time the map fails to init when
    // the viewer opens (trip-ui-init), NOT over the bare landing. So every degraded
    // test loads a trip first; the modal/notice appears once that runs.
    test("degraded gap (no WebGL) on desktop -> WebGL guide modal on first trip", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await killWebGL(page);
        await presetLocalStorage(page);
        await gotoApp(page, "en");

        // Nothing pops on the bare landing - not fatal, and the map hasn't tried yet.
        await expect(page.locator("#capability-gate")).toHaveCount(0);
        await expect(page.locator("#webgl-enable-modal")).toBeHidden();

        await loadTrip(page, SAMPLE_70MAI);

        // On a desktop browser, "no WebGL" looks like a fixable setting, so we
        // surface the actionable WebGL guide. Copy names WebGL on purpose (the
        // searchable term) and pairs it with the hardware-acceleration fix.
        const modal = page.locator("#webgl-enable-modal");
        await expect(modal).toBeVisible({ timeout: 15_000 });
        await expect(modal).toContainText(/needs WebGL/i);
        await expect(modal).toContainText(/hardware acceleration/i);
        await page.locator("#webgl-enable-close").click();
        await expect(modal).toBeHidden();
    });

    test("degraded gap (no WebGL) on mobile -> notice points at a computer, no modal", async ({ page }) => {
        // Mobile: the desktop hardware-acceleration steps don't exist on a phone,
        // so we show a short notice ("usually runs on a computer"), never the modal.
        // The isMobile guard pre-empts the modal regardless of any GPU signal, so we
        // deliberately do NOT killWebGPU here - the mobile routing must not depend on it.
        await page.setViewportSize(DESKTOP);
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "userAgent", {
                configurable: true,
                get: () =>
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            });
        });
        await killWebGL(page);
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        await expectMapNotice(page, /runs on a computer/i);
        await expect(page.locator("#webgl-enable-modal")).toBeHidden();
    });

    test("degraded gap (no WebGL) in an unrecognized browser -> 'try a mainstream browser' notice", async ({
        page,
    }) => {
        // Desktop but we can't name the browser and no GPU signal corroborates a
        // live GPU: toggling a setting we can't point at is useless, so we advise
        // switching to a mainstream browser instead.
        await page.setViewportSize(DESKTOP);
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "userAgent", {
                configurable: true,
                get: () => "ObscureBrowser/1.0 (X11; Linux x86_64)",
            });
        });
        await killWebGL(page);
        await killWebGPU(page);
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        await expectMapNotice(page, /try the latest Chrome, Edge, Firefox or Safari/i);
        await expect(page.locator("#webgl-enable-modal")).toBeHidden();
    });

    test("degraded gap (no WebGL) + open a trip: in-panel notice, body intact, app usable", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await killWebGL(page);
        await presetLocalStorage(page);
        await gotoApp(page, "en");

        // Not fatal - no blocking gate.
        await expect(page.locator("#capability-gate")).toHaveCount(0);

        // Open a real multichannel trip. ensureMap() returns null and flips the
        // map-init-failed path; trip-ui-init then surfaces the WebGL guide modal.
        await loadTrip(page, SAMPLE_70MAI);

        // The recoverable-gap modal pops once the viewer opens (desktop); dismiss
        // it so its focus-trap doesn't sit over the rest of the assertions.
        const enableModal = page.locator("#webgl-enable-modal");
        await expect(enableModal).toBeVisible({ timeout: 15_000 });
        await page.locator("#webgl-enable-close").click();
        await expect(enableModal).toBeHidden();

        // The body carries the no-WebGL flag class set by handleMapInitFailure...
        await expect
            .poll(() => page.evaluate(() => document.body.classList.contains("map-unavailable")), { timeout: 10_000 })
            .toBe(true);

        // ...but it must NOT collapse. Regression guard for the bare
        // ".map-unavailable" rules that used to also match <body class=...> and
        // shrink the whole document to a content-sized absolutely-positioned card.
        const body = await boxOf(page, "body");
        const vp = page.viewportSize();
        expect(vp, "viewport size must be known").not.toBeNull();
        expect(body.width, "body must stay full-viewport width, not shrink to a card").toBeGreaterThan(vp!.width - 4);
        expect(body.height, "body must stay full-viewport height").toBeGreaterThan(vp!.height - 4);

        // The in-panel map notice is visible, naming WebGL (the searchable term).
        const notice = page.locator("#map-unavailable");
        await expect(notice).toBeVisible();
        await expect(notice).toContainText(/needs WebGL/i);
        // The re-entry link to the guide is revealed (recoverable desktop gap).
        await expect(page.locator("#map-unavailable-how")).toBeVisible();

        // The mini-map circle is hidden (an empty ring is worse than nothing).
        await expect(page.locator("#mini-map")).toBeHidden();

        // The app is still usable without a map: the speed chart rendered.
        await expect(page.locator("#player-chart-canvas")).toBeVisible();

        await shot(page, "compat-03-no-webgl-trip");
    });

    test("degraded gap (no WebGL): a saved map overlay hides with its settings", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await killWebGL(page);
        await presetLocalStorage(page, {
            preferences: { "everydashcam:export:overlays": JSON.stringify({ overlayMap: { enabled: true } }) },
        });
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        const enableModal = page.locator("#webgl-enable-modal");
        await expect(enableModal).toBeVisible({ timeout: 15_000 });
        await page.locator("#webgl-enable-close").click();
        await expect(enableModal).toBeHidden();

        await openExport(page);
        await expect(page.locator("#export-panel-map-overlay-row")).toBeHidden();
        await expect(page.locator("#export-panel-ov-map")).not.toBeChecked();
        await expect(page.locator("#export-panel-overlay-inspector")).toBeHidden();
    });
});

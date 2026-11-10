import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import {
    expect,
    test as base,
    presetLocalStorage,
    loadTrip,
    openExport,
    installExportCapture,
    readExportResult,
    SAMPLE_70MAI,
} from "./_fixtures.js";

const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
};

// Serve two genuine worker revisions from one origin; Playwright routing cannot
// replace a service worker's update-script request.
interface UpdateServer {
    origin: string;
    publish: () => void;
}

const test = base.extend<{ updateServer: UpdateServer }>({
    baseURL: async ({ updateServer }, use) => {
        await use(updateServer.origin);
    },
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument; the server has no fixture dependencies.
    updateServer: async ({}, use) => {
        let version = 1;
        const server = createServer((request, response) => {
            const url = new URL(request.url!, "http://localhost");
            const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
            try {
                const bytes = readFileSync(resolve("dist", `.${relative}`));
                response.writeHead(200, {
                    "content-type": types[extname(relative)] ?? "application/octet-stream",
                    "cache-control": "no-store",
                });
                response.end(url.pathname === "/sw.js" ? `${bytes.toString()}\n// update-test-${version}` : bytes);
            } catch {
                response.writeHead(404);
                response.end("missing");
            }
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            await use({
                origin,
                publish: () => {
                    version++;
                },
            });
        } finally {
            await new Promise<void>((done) => {
                server.close(() => done());
                server.closeAllConnections();
            });
        }
    },
});

test.use({ serviceWorkers: "allow", viewerMap: "route-only" });

async function openApp(page: Page, origin: string, locale = "en"): Promise<void> {
    await page
        .context()
        .route(/^https?:\/\//, (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        sessionStorage.setItem("update-loads", String(Number(sessionStorage.getItem("update-loads") ?? 0) + 1));
    });
    await page.goto(`${origin}/${locale}/`);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function installUpdate(page: Page, publish: () => void): Promise<void> {
    publish();
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await expect(page.locator(".dc-toast .dc-toast__action")).toBeVisible();
}

const applyName = (locale: string): string => (locale === "en" ? "Update now" : "Обновить сейчас");

// A busy app answers the toast action directly, without the confirmation dialog.
async function requestUpdate(page: Page): Promise<void> {
    await page.locator(".dc-toast .dc-toast__action").last().click();
}

async function confirmUpdate(page: Page, locale = "en"): Promise<void> {
    await requestUpdate(page);
    await page.getByRole("button", { name: applyName(locale), exact: true }).click();
}

async function expectDialogFits(page: Page): Promise<void> {
    const viewport = page.viewportSize()!;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const bounds = await page.locator("#sw-update-modal .modal-card").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
}

// One worker update serves every layout check: the waiting worker is announced
// again after navigating to another locale, so only the final restart reloads it.
test("update confirmation fits each locale and viewport, then restarts the app", async ({
    page,
    updateServer,
}, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page, updateServer.origin, "en");
    await page.evaluate(() => localStorage.setItem("update-test-preference", "keep"));
    await installUpdate(page, updateServer.publish);
    const action = page.locator(".dc-toast .dc-toast__action");
    await expect(action).toHaveText("Update…");
    await action.click();
    await expect(page.locator("#sw-update-body")).toContainText("recordings again");
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expectDialogFits(page);
    await page.screenshot({ path: info.outputPath("update-en-1280.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(page.locator("#sw-update-modal")).toHaveCount(0);
    // The dismissed toast's action remains available in the bell drawer.
    await page.locator("#notif-bell").click();
    await page.locator("#notif-drawer .dc-toast__action").click();
    await expect(page.locator("#sw-update-modal")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${updateServer.origin}/ru/`);
    await expect(action).toHaveText("Обновить…");
    await action.click();
    await expect(page.locator("#sw-update-body")).toContainText("открыть заново");
    await expectDialogFits(page);
    await page.screenshot({ path: info.outputPath("update-ru-390.png"), animations: "disabled" });
    await page.setViewportSize({ width: 844, height: 390 });
    await expectDialogFits(page);
    await page.screenshot({ path: info.outputPath("update-ru-landscape.png"), animations: "disabled" });
    expect(await page.evaluate(() => sessionStorage.getItem("update-loads"))).toBe("2");

    await page.getByRole("button", { name: applyName("ru"), exact: true }).click();
    await page.waitForFunction(() => sessionStorage.getItem("update-loads") === "3");
    await page.waitForFunction(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return navigator.serviceWorker.controller !== null && !registration?.waiting;
    });
    expect(await page.evaluate(() => localStorage.getItem("update-test-preference"))).toBe("keep");
    expect(new URL(page.url()).pathname).toBe("/ru/");
});

test("a busy export cancels the attempt; a retry restarts the app and keeps notes", async ({ page, updateServer }) => {
    test.setTimeout(120_000);
    await installExportCapture(page, undefined, { pickerDelayMs: 8000 });
    await openApp(page, updateServer.origin, "ru");
    await loadTrip(page, SAMPLE_70MAI);
    const trip = page.locator("li.trip").first();
    await trip.locator(".trip-edit").click();
    await page.locator("#trip-meta-note").fill("Keep this note after updating");
    await page.locator("#trip-meta-save").click();
    await page.locator("#notes-storage-browser").click();
    await expect(page.locator("#notes-storage-modal")).toBeHidden();
    await installUpdate(page, updateServer.publish);
    await openExport(page);
    await page.locator("#export-panel-save-btn").click();
    await requestUpdate(page);
    await expect(page.locator(".dc-toast", { hasText: "Приложение занято." })).toBeVisible();
    await expect(page.locator("#sw-update-modal")).toHaveCount(0);
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });
    expect((await readExportResult(page))?.len).toBeGreaterThan(1024);
    // Completion does not trigger a deferred restart: the user must close the
    // Save clip panel and retry.
    expect(await page.evaluate(() => sessionStorage.getItem("update-loads"))).toBe("1");
    await page.locator("#export-panel-close").click();
    // Action toasts expire during a long export; the drawer keeps the update action.
    await page.locator("#notif-bell").click();
    await page.locator("#notif-drawer .dc-toast__action").click();
    await page.getByRole("button", { name: applyName("ru"), exact: true }).click();
    await page.waitForFunction(() => sessionStorage.getItem("update-loads") === "2");
    expect(new URL(page.url()).pathname).toBe("/ru/");
    await loadTrip(page, SAMPLE_70MAI);
    await expect(page.locator(".trip-note")).toHaveText("Keep this note after updating");
});

test("another app window must close before the update restarts the app", async ({ page, context, updateServer }) => {
    test.setTimeout(60_000);
    await openApp(page, updateServer.origin);
    const other = await context.newPage();
    await other.goto(`${updateServer.origin}/ru/`);
    await installUpdate(page, updateServer.publish);
    await confirmUpdate(page);
    await expect(page.locator(".dc-toast__body").last()).toContainText("Other everydashcam tabs or windows are open.");
    await expect(page.locator("#sw-update-modal")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("update-loads"))).toBe("1");
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(
        true,
    );
    // Normal reload still announces an update that was already waiting.
    await page.reload();
    await expect(page.locator(".dc-toast .dc-toast__action")).toBeVisible();
    await other.close();
    await confirmUpdate(page);
    await page.waitForFunction(() => sessionStorage.getItem("update-loads") === "3");
});

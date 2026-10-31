import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("reconnect recovers a failed first installation without reloading the open page", async ({ page, context }) => {
    test.setTimeout(90_000);
    let failInstall = true;
    let installAttempts = 0;
    const types: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".webmanifest": "application/manifest+json",
    };
    const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://localhost").pathname;
        if (path === "/install-ready") {
            installAttempts++;
            response.writeHead(failInstall ? 503 : 200, { "cache-control": "no-store" });
            response.end();
            return;
        }
        const relative = path.endsWith("/") ? `${path}index.html` : path;
        try {
            const bytes = readFileSync(resolve("dist", `.${relative}`));
            response.writeHead(200, {
                "content-type": types[extname(relative)] ?? "application/octet-stream",
                "cache-control": "no-store",
            });
            // A real failing install keeps register() successful while its worker
            // becomes redundant. The next attempt uses the same worker bytes.
            const installGate = `
self.addEventListener("install", (event) => {
    event.waitUntil(fetch("/install-ready").then((response) => {
        if (!response.ok) throw new Error("installation dependency unavailable");
    }));
});`;
            response.end(path === "/sw.js" ? `${bytes.toString()}${installGate}` : bytes);
        } catch {
            response.writeHead(404);
            response.end("missing");
        }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await context.route(/^https?:\/\//, (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await page.addInitScript(() => {
            addEventListener("dc:ready", () => {
                document.documentElement.dataset.testAppReady = "true";
            });
        });
        await page.goto(`${origin}/en/`);
        await expect(page.locator("html")).toHaveAttribute("data-test-app-ready", "true");
        await expect.poll(() => installAttempts).toBe(1);
        await expect
            .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length))
            .toBe(0);
        expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
        await page.evaluate(() => {
            document.documentElement.dataset.openRecordingSentinel = "still-open";
        });
        await context.setOffline(true);
        failInstall = false;
        await context.setOffline(false);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        expect(installAttempts).toBe(2);
        await expect(page.locator("html")).toHaveAttribute("data-open-recording-sentinel", "still-open");
        await context.setOffline(true);
        const response = await page.reload();
        expect(response?.fromServiceWorker()).toBe(true);
        await expect(page.locator("html")).toHaveAttribute("data-test-app-ready", "true");
    } finally {
        await context.setOffline(false);
        await page.goto("about:blank");
        await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
        });
    }
});

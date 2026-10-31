import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { expect, test } from "@playwright/test";

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

test.use({ serviceWorkers: "allow" });

for (const locale of ["en", "ru"]) {
    test.describe(locale, () => {
        test.use({ locale });
        for (const width of [1280, 390]) {
            test(`waiting update explains a safe restart in ${locale} at ${width}px`, async ({
                page,
                context,
            }, info) => {
                test.setTimeout(90_000);
                let version = "first";
                const server = createServer((request, response) => {
                    const url = new URL(request.url!, "http://localhost");
                    const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
                    try {
                        const bytes = readFileSync(resolve("dist", `.${relative}`));
                        response.writeHead(200, {
                            "content-type": types[extname(relative)] ?? "application/octet-stream",
                            "cache-control": "no-store",
                        });
                        response.end(url.pathname === "/sw.js" ? `${bytes.toString()}\n// ${version}` : bytes);
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
                    await page.setViewportSize({ width, height: 900 });
                    await page.goto(`${origin}/${locale}/`);
                    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
                    await expect(page.locator(".dc-toast__body")).toHaveCount(0);
                    await page.evaluate(() => {
                        document.documentElement.dataset.openRecordingSentinel = "still-open";
                        localStorage.setItem("update-test-preference", "keep");
                    });
                    version = "second";
                    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
                    const message =
                        locale === "en"
                            ? "An update is ready. When you're done, close all everydashcam tabs and windows, then reopen the app."
                            : "Обновление готово. Когда закончишь работу, закрой все вкладки и окна everydashcam, затем открой приложение снова.";
                    await expect(page.locator(".dc-toast__body")).toHaveText(message);
                    await expect(page.locator("html")).toHaveAttribute("data-open-recording-sentinel", "still-open");
                    expect(await page.evaluate(() => localStorage.getItem("update-test-preference"))).toBe("keep");
                    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
                    await page.screenshot({
                        path: info.outputPath(`update-${locale}-${width}.png`),
                        animations: "disabled",
                    });
                    // Reopening an existing waiting registration must announce it too.
                    await page.reload();
                    await expect(page.locator(".dc-toast__body")).toHaveText(message);
                    expect(
                        await page.evaluate(async () =>
                            Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
                        ),
                    ).toBe(true);
                } finally {
                    await page.goto("about:blank");
                    await new Promise<void>((done) => {
                        server.close(() => done());
                        server.closeAllConnections();
                    });
                }
            });
        }
    });
}

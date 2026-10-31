import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { readPortableArtifacts } from "../../scripts/_portable-artifacts.mjs";
import { presetLocalStorage } from "../e2e/_fixtures.js";

let server: ViteDevServer;
let origin: string;
const manifest = readPortableArtifacts(resolve("dist-portable/manifest.json"), true);

test.beforeAll(async () => {
    server = await createServer({
        configFile: resolve("vite.config.ts"),
        envFile: false,
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("development server has no local address");
    origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
    await server?.close();
});

for (const mobile of [false, true]) {
    test.describe(mobile ? "touch screen" : "desktop", () => {
        test.use({ hasTouch: mobile, isMobile: mobile, viewport: { width: mobile ? 390 : 1440, height: 900 } });

        test("downloads the exact portable file from an already installed app", async ({ page }, info) => {
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });
            await page.route(/^https?:/, (route) =>
                route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
            );
            await presetLocalStorage(page, { theme: mobile ? "dark" : "light" });
            await page.addInitScript(() => {
                const matchMedia = window.matchMedia.bind(window);
                window.matchMedia = (query) => {
                    const result = matchMedia(query);
                    if (query === "(display-mode: standalone)") {
                        Object.defineProperty(result, "matches", { value: true });
                    }
                    return result;
                };
            });
            await page.goto(`${origin}/ru/`);
            const modal = page.locator("#offline-use-modal");
            // Prerendered HTML can reveal before the dev entry imports the app.
            // This state is set after the chooser's click handler is attached.
            await expect(modal).toHaveAttribute("data-install-state", "installed");
            if (mobile) {
                await page.locator("#topbar-overflow").click();
                await page.locator("#topbar-overflow-menu").getByRole("menuitem", { name: "Без интернета" }).click();
            } else {
                await page.locator("#offline-use-btn").click();
            }
            await expect(modal).toBeVisible();
            await expect(page.locator("#install-btn")).toBeHidden();
            const downloadLink = page.locator("#portable-download");
            await expect(downloadLink).toBeVisible();
            await expect(page.locator("#offline-use-size")).toContainText("МБ");
            await downloadLink.scrollIntoViewIfNeeded();
            const pending = page.waitForEvent("download");
            await downloadLink.click();
            const download = await pending;
            expect(download.suggestedFilename()).toBe(manifest.files.ru!.filename);
            const path = info.outputPath("downloaded.html");
            await download.saveAs(path);
            expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(manifest.files.ru!.sha256);
            expect(page.url()).toBe(`${origin}/ru/`);
            await page.screenshot({ path: info.outputPath("offline-choice.png") });
            expect(errors).toEqual([]);
        });
    });
}

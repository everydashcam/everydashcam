// Render self-contained brand artwork with the project's existing Playwright.
import { chromium } from "@playwright/test";

/** Renders exactly width x height pixels without network or file subresources.
 * System Chrome remains usable when the pinned Playwright browser is absent. */
export async function renderHtmlToPng({ html, width, height, outPath }) {
    let browser;
    try {
        browser = await chromium.launch({ channel: "chromium" });
    } catch (error) {
        if (!/executable doesn't exist/i.test(String(error))) throw error;
        browser = await chromium.launch({ channel: "chrome" });
    }
    try {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        const externalResources = [];
        await page.route("**/*", (route) => {
            externalResources.push(route.request().url());
            return route.abort();
        });
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(Array.from(document.images, (image) => image.decode()));
        });
        if (externalResources.length) throw new Error("brand artwork must inline every subresource");
        await page.screenshot({ path: outPath, type: "png" });
    } finally {
        await browser.close();
    }
}

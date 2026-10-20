import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { decodePortableHtml } from "../../scripts/_portable-content.mjs";
import { PORTABLE_UPDATE_URL } from "../../src/portable/manifest.mjs";
import { portableFilename } from "../../src/portable/release-tags.mjs";

let directory: string;
let fileUrl: string;
const version = "v2026.01.01.2";

test.beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "everydashcam update "));
    execFileSync(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/build-portable.mjs",
            "--locale",
            "en",
            "--version",
            version,
            "--out-dir",
            directory,
        ],
        {
            cwd: resolve("."),
            stdio: "pipe",
        },
    );
    const filename = portableFilename(version, "en");
    const renamed = join(directory, "Проверка обновления.html");
    copyFileSync(join(directory, filename), renamed);
    fileUrl = pathToFileURL(renamed).href;
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

function metadata(remoteVersion: string, locale = "en"): string {
    const filename = portableFilename(remoteVersion, locale);
    return JSON.stringify({
        schemaVersion: 1,
        distribution: "public",
        version: remoteVersion,
        files: {
            [locale]: {
                filename,
                path: `/downloads/portable/${remoteVersion}/${filename.replace(/\.html$/, "")}`,
                bytes: 1_000_000,
                sha256: "a".repeat(64),
            },
        },
    });
}

test("checks only public metadata from a renamed file and offers the newer locale download", async ({ page }) => {
    const requests: string[] = [];
    await page.route("https://**/*", async (route) => {
        const request = route.request();
        requests.push(request.url());
        expect(request.url()).toBe(PORTABLE_UPDATE_URL);
        expect(request.method()).toBe("GET");
        expect(request.postData()).toBeNull();
        const headers = await request.allHeaders();
        expect(headers.referer).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        await route.fulfill({
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: metadata("v2026.01.01.10"),
        });
    });
    await page.goto(fileUrl);
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    const anchor = page.locator("#portable-update");
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveAttribute("download", "everydashcam-2026-01-01.10-en.html");
    await expect(anchor).toHaveAttribute("href", "https://everydashcam.app/downloads/portable/en.html");
    await page.evaluate(() => {
        dispatchEvent(new Event("online"));
        dispatchEvent(new Event("online"));
    });
    expect(requests).toEqual([PORTABLE_UPDATE_URL]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#topbar-overflow").click();
    await expect(page.locator("#topbar-overflow-menu")).toContainText("A newer version is available");
    expect(page.url()).toBe(fileUrl);
});

for (const remoteVersion of [version, "v2026.01.01", "v2025.12.31.10"]) {
    test(`does not offer ${remoteVersion} over ${version}`, async ({ page }) => {
        let complete!: () => void;
        const checked = new Promise<void>((done) => {
            complete = done;
        });
        await page.route(PORTABLE_UPDATE_URL, async (route) => {
            await route.fulfill({
                contentType: "application/json",
                headers: { "Access-Control-Allow-Origin": "*" },
                body: metadata(remoteVersion),
            });
            complete();
        });
        await page.goto(fileUrl);
        await checked;
        await expect(page.locator("#portable-update")).toBeHidden();
    });
}

test("retries once after reconnection and falls back to the primary locale page", async ({ page }) => {
    let attempts = 0;
    await page.route(PORTABLE_UPDATE_URL, async (route) => {
        attempts++;
        if (attempts === 1) return route.abort("internetdisconnected");
        await route.fulfill({
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: metadata("v2026.01.02", "ru"),
        });
    });
    await page.goto(fileUrl);
    await expect.poll(() => attempts).toBe(1);
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    // Wait for the failed fetch to settle before the actual reconnection signal.
    await page.waitForFunction(() =>
        performance.getEntriesByType("resource").some((entry) => entry.name.endsWith("latest.json")),
    );
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator("#portable-update")).toHaveAttribute("href", "https://everydashcam.app/en/");
    await page.evaluate(() => {
        dispatchEvent(new Event("online"));
        dispatchEvent(new Event("online"));
    });
    expect(attempts).toBe(2);
});

test("retries when the browser reconnects before the offline request settles", async ({ page }) => {
    let attempts = 0;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(PORTABLE_UPDATE_URL, async (route) => {
        attempts++;
        if (attempts === 1) {
            await stalled;
            await route.abort("internetdisconnected");
            return;
        }
        await route.fulfill({
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: metadata("v2026.01.02"),
        });
    });
    try {
        await page.goto(fileUrl);
        await expect.poll(() => attempts).toBe(1);
        await expect(page.locator("#landing-cta")).toBeEnabled();
        await page.evaluate(() => dispatchEvent(new Event("online")));
        expect(attempts).toBe(1);
        release();
        await expect(page.locator("#portable-update")).toBeVisible();
        await page.evaluate(() => dispatchEvent(new Event("online")));
        expect(attempts).toBe(2);
    } finally {
        release();
    }
});

test("embeds its final script hashes and excludes automatic application replacement", () => {
    const outer = readFileSync(join(directory, portableFilename(version, "en")), "utf8");
    const html = decodePortableHtml(outer);
    for (const document of [outer, html]) {
        const csp = document.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
        expect(csp).toBeDefined();
        for (const match of document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
            if (/type="application\/(?:gzip|(?:ld\+)?json)"/.test(match[1]!)) continue;
            const hash = createHash("sha256").update(match[2]!).digest("base64");
            expect(csp).toContain(`sha256-${hash}`);
            expect(outer).toContain(`sha256-${hash}`);
        }
    }
    expect(html).not.toContain('src="/assets/');
    expect(html).not.toContain('id="install-btn"');
    expect(html).not.toContain("__DC_LANGS__");
});

test("ignores a CORS rejection from the metadata endpoint without blocking local use", async ({ page }) => {
    const corsErrors: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error" && /CORS|Access-Control-Allow-Origin/.test(message.text())) {
            corsErrors.push(message.text());
        }
    });
    await page.route(PORTABLE_UPDATE_URL, (route) =>
        route.fulfill({
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "https://unrelated.example.invalid" },
            body: metadata("v2026.01.02"),
        }),
    );
    await page.goto(fileUrl);
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await expect.poll(() => corsErrors.length).toBeGreaterThan(0);
    await expect(page.locator("#portable-update")).toBeHidden();
    await expect(page.locator("#landing-cta")).toBeEnabled();
});

for (const body of [
    "invalid json",
    JSON.stringify({ schemaVersion: 1, distribution: "public", version: "v2026.01.02", files: {} }),
]) {
    test(`ignores malformed metadata ${body.startsWith("{") ? "schema" : "JSON"} without retrying on reconnection`, async ({
        page,
    }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let attempts = 0;
        await page.route(PORTABLE_UPDATE_URL, async (route) => {
            attempts++;
            await route.fulfill({
                contentType: "application/json",
                headers: { "Access-Control-Allow-Origin": "*" },
                body,
            });
        });
        const finished = page.waitForEvent("requestfinished", (request) => request.url() === PORTABLE_UPDATE_URL);
        await page.goto(fileUrl);
        await finished;
        await expect(page.locator("html")).not.toHaveClass(/is-loading/);
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.locator("#portable-update")).toBeHidden();
        await expect(page.locator("#landing-cta")).toBeEnabled();
        expect(attempts).toBe(1);
        expect(errors).toEqual([]);
    });
}

test("times out stalled metadata while the file stays usable and retries once on reconnection", async ({ page }) => {
    let attempts = 0;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
        release = resolve;
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(PORTABLE_UPDATE_URL, async (route) => {
        attempts++;
        if (attempts === 1) {
            await stalled;
            await route.abort().catch(() => undefined);
            return;
        }
        await route.fulfill({
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: metadata("v2026.01.02"),
        });
    });
    try {
        const aborted = page.waitForEvent("requestfailed", {
            predicate: (request) => request.url() === PORTABLE_UPDATE_URL,
            timeout: 10_000,
        });
        await page.goto(fileUrl);
        await expect.poll(() => attempts).toBe(1);
        await expect(page.locator("html")).not.toHaveClass(/is-loading/);
        await expect(page.locator("#landing-cta")).toBeEnabled();
        await expect(page.locator("#portable-update")).toBeHidden();
        await aborted;
        release();
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.locator("#portable-update")).toBeVisible();
        await page.evaluate(() => {
            dispatchEvent(new Event("online"));
            dispatchEvent(new Event("online"));
        });
        expect(attempts).toBe(2);
        expect(errors).toEqual([]);
    } finally {
        release();
    }
});

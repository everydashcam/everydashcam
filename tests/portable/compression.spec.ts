import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { type Page, expect, test as base } from "@playwright/test";
import { PORTABLE_UPDATE_URL } from "../../src/portable/manifest.mjs";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { manifest, openPortable, test } from "./_fixtures.js";

function transformPayload(html: string, transform: (compressed: Buffer) => Buffer): string {
    const payload = html.match(/(<script\b[^>]*\bid="dc-portable-payload"[^>]*>)([^<]+)(<\/script>)/);
    expect(payload, "the download contains a gzip payload").not.toBeNull();
    const compressed = transform(Buffer.from(payload![2]!, "base64"));
    return html.replace(payload![0], `${payload![1]}${compressed.toString("base64")}${payload![3]}`);
}

async function copyPortable(
    outputDirectory: string,
    transform: (html: string) => string = (html) => html,
): Promise<string> {
    const source = await readFile(resolve("dist-portable", manifest.files.en!.filename), "utf8");
    await mkdir(outputDirectory, { recursive: true });
    const target = resolve(outputDirectory, "Проверка сжатого файла.html");
    await writeFile(target, transform(source));
    return pathToFileURL(target).href;
}

async function expectStartupFailure(page: Page, message: string): Promise<void> {
    await expect(page.locator("html")).toHaveAttribute("data-portable-state", "error");
    await expect(page.locator("html")).not.toHaveClass(/is-loading/);
    await expect(page.locator("#dc-portable-startup")).toBeVisible();
    await expect(page.locator("#dc-portable-status")).toHaveText(message);
    await expect(page.locator("#dc-portable-full-version")).toHaveAttribute("href", "https://everydashcam.app/en/");
    await expect(page.locator("#dc-portable-full-version")).toBeVisible();
    await expect(page.locator("#landing-cta")).toHaveCount(0);
    expect(page.workers()).toHaveLength(0);
}

test("restores the compressed application once in the original file document", async ({ page, requests }, info) => {
    void requests;
    await presetLocalStorage(page, { lang: "en" });
    await page.addInitScript(() => {
        const state = { originalDocument: document, readyCount: 0 };
        Object.defineProperty(window, "__portableCompressionProbe", { value: state });
        addEventListener("dc:ready", () => state.readyCount++);
    });
    const url = await openPortable(page, info.outputPath("compressed startup"), "ru");
    await expect(page.locator("html")).toHaveAttribute("data-portable-state", "ready");
    await expect(page.locator("html")).toHaveClass(/dc-dark/);
    await expect(page.locator("#landing-cta")).toBeEnabled();
    await expect(page.locator("#dc-i18n")).toHaveCount(1);
    await expect(page.locator("#dc-portable-startup, #dc-portable-payload")).toHaveCount(0);
    await expect(page.locator("script[src], iframe")).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect(
        await page.evaluate(() => {
            const state = (
                window as unknown as {
                    __portableCompressionProbe: { originalDocument: Document; readyCount: number };
                }
            ).__portableCompressionProbe;
            return { sameDocument: document === state.originalDocument, readyCount: state.readyCount };
        }),
    ).toEqual({ sameDocument: true, readyCount: 1 });
});

test("explains an unavailable native decompressor without starting the application", async ({
    page,
    requests,
}, info) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, "DecompressionStream", { value: undefined, configurable: true });
    });
    const url = await copyPortable(info.outputPath("unsupported browser"));
    await page.goto(url);
    await expectStartupFailure(
        page,
        "This browser can’t open the offline version. Update it or open the full version.",
    );
    expect(page.url()).toBe(url);
    expect(requests).toEqual([]);
});

test("reports a damaged gzip checksum without restoring a partial application", async ({ page, requests }, info) => {
    const url = await copyPortable(info.outputPath("damaged download"), (html) => {
        return transformPayload(html, (compressed) => {
            compressed[compressed.length - 8] = compressed[compressed.length - 8]! ^ 1;
            return compressed;
        });
    });
    await page.goto(url);
    await expectStartupFailure(page, "Couldn’t open everydashcam. Download the file again or open the full version.");
    expect(page.url()).toBe(url);
    expect(requests).toEqual([]);
});

test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("keeps a visible full-version destination", async ({ page, requests }, info) => {
        const url = await copyPortable(info.outputPath("javascript disabled"));
        await page.goto(url);
        await expect(page.locator("noscript p")).toBeVisible();
        await expect(page.locator("noscript p")).not.toHaveText("");
        await expect(page.locator("#dc-portable-full-version")).toBeVisible();
        await expect(page.locator("#dc-portable-full-version")).toHaveAttribute("href", "https://everydashcam.app/en/");
        expect(requests).toEqual([]);
    });
});

base("retains the hash-based script policy after restoring the document", async ({ page }, info) => {
    const errors: string[] = [];
    const policyErrors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (message.location().url === PORTABLE_UPDATE_URL && /net::ERR_/.test(message.text())) return;
        if (/Executing inline script violates.*Content Security Policy/.test(message.text())) {
            policyErrors.push(message.text());
        } else errors.push(message.text());
    });
    await page.route(/^https?:/, (route) => route.abort());
    await presetLocalStorage(page);
    const url = await openPortable(page, info.outputPath("retained script policy"));
    await expect(page.locator("html")).toHaveAttribute("data-portable-state", "ready");
    const directive = await page.evaluate(
        () =>
            new Promise<string>((done) => {
                window.addEventListener("securitypolicyviolation", (event) => done(event.effectiveDirective), {
                    once: true,
                });
                const script = document.createElement("script");
                script.textContent = 'document.documentElement.dataset.unapprovedScript = "executed"';
                document.body.append(script);
            }),
    );
    expect(directive).toBe("script-src-elem");
    await expect(page.locator("html")).not.toHaveAttribute("data-unapproved-script");
    expect(page.url()).toBe(url);
    expect(policyErrors.length).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
});

for (const fault of ["blocked script", "startup exception"]) {
    base(`restores the startup error page after a ${fault}`, async ({ page }, info) => {
        const errors: string[] = [];
        const expectedErrors: string[] = [];
        const requests: string[] = [];
        const isExpected = (message: string): boolean =>
            fault === "blocked script"
                ? /Executing inline script violates.*Content Security Policy/.test(message)
                : message.includes("portable startup exception probe");
        const recordError = (message: string): void => {
            (isExpected(message) ? expectedErrors : errors).push(message);
        };
        page.on("pageerror", (error) => recordError(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") recordError(message.text());
        });
        await page.route(/^https?:/, (route) => {
            requests.push(route.request().url());
            return route.abort();
        });
        const url = await copyPortable(info.outputPath(fault), (html) => {
            let oldHash = "";
            const replacement = 'throw new Error("portable startup exception probe");';
            const newHash = createHash("sha256").update(replacement).digest("base64");
            const modified = transformPayload(html, (compressed) => {
                let inner = gunzipSync(compressed).toString("utf8");
                const app = inner.match(/(<script type="module">)([\s\S]*?)(<\/script>)/);
                expect(app, "the compressed document contains the inline application").not.toBeNull();
                oldHash = createHash("sha256").update(app![2]!).digest("base64");
                inner = inner.replace(app![0], `${app![1]}${replacement}${app![3]}`);
                if (fault === "startup exception") inner = inner.replaceAll(oldHash, newHash);
                return gzipSync(inner);
            });
            return fault === "startup exception" ? modified.replaceAll(oldHash, newHash) : modified;
        });
        await page.goto(url);
        await expectStartupFailure(
            page,
            "Couldn’t open everydashcam. Download the file again or open the full version.",
        );
        expect(page.url()).toBe(url);
        expect(expectedErrors.length).toBeGreaterThanOrEqual(1);
        expect(errors).toEqual([]);
        expect(requests).toEqual([]);
    });
}
